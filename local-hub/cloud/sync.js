import { getCommandPolicy } from '../command-reliability.js';

export function createHubSync({ config, cloud, executionStore, routing, heartbeatStore, appDiscovery, diagnostics, provisioning, runner, worker, reconciler, log = () => {} } = {}) {
    let syncInFlight = false;
    let knownDevicesBootstrapped = false;
    const autoStartInFlightByStableSerial = new Set();

    function selectExecutionSerial(activeSerials) { return activeSerials.find((serial) => serial.includes(':')) || activeSerials[0] || '1G0YK01234'; }

    async function bootstrapKnownDevices() {
        if (knownDevicesBootstrapped) return;
        try {
            const response = await cloud.getDevices();
            const devices = response.json;
            if (Array.isArray(devices)) {
                for (const device of devices) {
                    const stableSerial = device.stable_id || device.serial_number;
                    if (!stableSerial) continue;
                    routing.rememberWirelessRoute(stableSerial, { knownDevice: true, usbSerial: device.serial_number || null, ip: device.last_known_ip || device.wifi_ip || device.ip_address || null, previousIps: Array.isArray(device.previous_ips) ? device.previous_ips : [], wifiSsid: device.wifi_ssid || null, agentId: device.agent_id || device.pairing_id || null, androidId: device.android_id || null, model: device.model || 'Meta Quest', hadSuccessfulWifiConnection: Boolean(device.last_known_ip || device.wifi_ip || device.ip_address) });
                }
            }
            knownDevicesBootstrapped = true;
        } catch (error) {
            log('Bootstrap', `Failed to load known devices: ${error.message}`);
        }
    }

    async function flushResultOutbox() {
        executionStore.resetExhaustedOutbox();
        for (const item of executionStore.pendingOutbox(100)) {
            const attempt = Number(item.attempt || 0) + 1;
            const result = JSON.parse(item.result_json || '{}');
            const ok = await cloud.sendCommandStatus(item.command_id, item.status, { claim_token: item.claim_token, result, error_message: result.error, error_code: result.error_code, outcome_state: item.status === 'timeout' ? 'unknown' : 'known', result_delivery_attempt: attempt });
            if (ok) executionStore.markOutboxDelivered(item.command_id);
            else if (attempt <= 8) {
                executionStore.markOutboxAttempt(item.command_id, 'Cloud unavailable or rejected result', Math.min(60000, 1000 * (2 ** Math.min(attempt, 6))));
                if (attempt === 8) log('ResultDelivery', 'Terminal result retained durably after bounded delivery burst', { commandId: item.command_id, resultDeliveryAttempt: attempt, errorCode: 'CLOUD_RESULT_DELIVERY_FAILED' });
            } else log('ResultDelivery', 'Terminal result remains pending after bounded delivery attempts', { commandId: item.command_id, resultDeliveryAttempt: attempt, errorCode: 'CLOUD_RESULT_DELIVERY_FAILED' });
        }
        executionStore.prune();
    }

    async function reportCommandStatus(cmd, status, result = {}, options = {}) {
        const body = { error_message: result?.error, error_code: result?.errorCode || options.errorCode, outcome_state: options.outcomeState || (status === 'succeeded' ? 'known' : status === 'timeout' ? 'unknown' : 'known'), reconciled: Boolean(result?.reconciled || options.reconciled), route: options.route || null, result, claim_token: cmd?.claim_token || options.claimToken || null };
        if (['succeeded', 'failed', 'timeout', 'cancelled'].includes(status)) {
            executionStore.enqueue(cmd.id, status, result, { claimToken: cmd?.claim_token });
            return flushResultOutbox();
        }
        const ok = await cloud.sendCommandStatus(cmd.id, status, body);
        if (!ok) log('ResultDelivery', `Cloud status request failed for command ${cmd.id}`, { status });
    }

    async function maybeAutoStartAgent(route, health) {
        const stableSerial = route?.stableSerial;
        if (!stableSerial || autoStartInFlightByStableSerial.has(stableSerial) || health?.connection_status === undefined) return;
        const eligible = ['wifi_ready', 'adb_online_agent_offline'].includes(health.connection_status);
        const known = Boolean(route.agentId || route.pairingId || route.knownDevice || routing.wirelessStateIndex[stableSerial]?.knownDevice);
        if (!eligible || !known) return;
        const state = routing.wirelessStateIndex[stableSerial] || {};
        if ((Date.now() - Number(state.lastAutoStartAttemptAt || 0)) < config.AUTO_START_AGENT_RETRY_MS) return;
        const executionSerial = await routing.resolveExecutionSerial(stableSerial) || route.executionSerial || route.wirelessSerial || route.usbSerial;
        if (!executionSerial) return;
        try {
            const installed = await runner.capture(['-s', executionSerial, 'shell', 'pm', 'path', config.QUEST_AGENT_PACKAGE]);
            if (!String(installed).includes('package:') || !String(installed).includes(config.QUEST_AGENT_PACKAGE)) {
                log('Agent', `Quest Agent package ${config.QUEST_AGENT_PACKAGE} is not installed on ${stableSerial}`);
                return;
            }
        } catch { return; }
        autoStartInFlightByStableSerial.add(stableSerial);
        routing.rememberWirelessRoute(stableSerial, { lastAutoStartAttemptAt: Date.now() });
        log('Agent', `Auto-starting Quest Agent for ${stableSerial} via ${executionSerial}`);
        void runner.spawnAdb(provisioning.buildStartArgs(executionSerial), 'Quest Agent auto-started').then((result) => {
            if (!result.success) log('Agent', 'Auto-start failed', { stableSerial, error: result.error || result });
        }).finally(() => autoStartInFlightByStableSerial.delete(stableSerial));
    }

    async function buildDeviceDetails(activeSerials) {
        const deviceDetails = [];
        for (const route of Object.values(routing.routes)) {
            const heartbeat = routing.findAgentHeartbeatForRoute(route);
            route.agentOnline = Boolean(heartbeat);
            if (heartbeat?.agent_id || heartbeat?.pairing_id) {
                route.agentId = heartbeat.agent_id || heartbeat.pairing_id;
                routing.rememberWirelessRoute(route.stableSerial, { agentId: route.agentId });
            }
            await routing.supervisor.tick(route, { route, heartbeatIp: heartbeat?.local_ip || null });
            const executionSerial = route.executionSerial || route.stableSerial;
            const health = routing.summarizeRouteHealth(route);
            void maybeAutoStartAgent(route, health).catch((error) => log('Agent', 'Auto-start probe failed', { stableSerial: route.stableSerial, error: error.message }));
            const battery = executionSerial && executionSerial !== '1G0YK01234' && health.adb_status === 'online' ? await diagnostics.getBattery(executionSerial) : 85;
            const installedApps = executionSerial && executionSerial !== '1G0YK01234' && health.adb_status === 'online' ? await appDiscovery.getLaunchableApps(executionSerial) : [];
            deviceDetails.push({ serial: route.stableSerial, stable_id: route.stableSerial, usb_serial: route.usbSerial || route.stableSerial, agent_id: route.agentId || null, android_id: route.androidId || null, model: route.model || 'Meta Quest', battery, installed_apps: installedApps, wifi_ssid: route.wifiSsid || null, ip_address: health.wifi_ip, previous_ips: health.previous_ips || [], active_route: route.executionSerial || route.wirelessSerial || route.usbSerial || null, adb_status: health.adb_status, agent_status: health.agent_status, connection_status: health.connection_status, wifi_ready: health.wifi_ready, usb_repair_required: health.usb_repair_required, status_reason: health.status_reason, next_step: health.next_step, transport: health.transport, wake_supported: health.wake_supported, ip_changed: health.ip_changed, app_version: heartbeat?.app_version || null, adb_recovery_status: health.adb_recovery_status || null, adb_recovery_permission: health.adb_recovery_permission || null, adb_metrics: routing.supervisor.getMetrics(route.stableSerial), adb_last_reconnect: routing.supervisor.getState(route.stableSerial)?.lastReconnect || null, adb_command_metrics: routing.adbCommandMetricsByStableSerial.get(route.stableSerial) || null });
        }
        return deviceDetails;
    }

    async function processCommand(cmd, activeSerials) {
        log('Command', `Received command ${cmd.type}#${cmd.id} for device ${cmd.device_id}`);
        const journal = cmd.recovery_required ? executionStore.recoverAfterRestart(cmd) : executionStore.claim(cmd);
        if (journal.kind === 'integrity_violation') return reportCommandStatus(cmd, 'failed', { success: false, error: 'Command payload or target identity changed for an existing command id', errorCode: 'COMMAND_INTEGRITY_VIOLATION' }, { errorCode: 'COMMAND_INTEGRITY_VIOLATION' });
        if (['already_done', 'in_flight', 'cancelled'].includes(journal.kind)) return;
        const targetStableSerial = typeof cmd.device_serial_number === 'string' ? cmd.device_serial_number : selectExecutionSerial(activeSerials);
        const executionSerial = targetStableSerial ? await routing.resolveExecutionSerial(targetStableSerial) : null;
        log('Routing', `Resolved command route for ${cmd.type}#${cmd.id}`, { targetStableSerial, executionSerial });
        const canRunWithoutCurrentRoute = ['RECONNECT_ADB', 'FORGET_DEVICE'].includes(String(cmd.type));
        if (journal.kind === 'reconciliation_required' || journal.kind === 'unknown_outcome') {
            const reconciliation = executionSerial && journal.policy?.reconciliable ? await reconciler.reconcile(cmd, executionSerial, targetStableSerial) : { success: false, unknown: true, error: 'Side effect may have happened before Local Hub restart; no safe blind retry is allowed', errorCode: 'COMMAND_OUTCOME_UNKNOWN' };
            if (reconciliation.success) { executionStore.complete(cmd.id, reconciliation, { claimToken: cmd.claim_token }); await reportCommandStatus(cmd, 'succeeded', reconciliation, { reconciled: true, route: executionSerial }); }
            else { executionStore.markUnknown(cmd.id, reconciliation.error, { errorCode: reconciliation.errorCode || 'COMMAND_RECONCILIATION_FAILED' }); await reportCommandStatus(cmd, 'timeout', { success: false, error: reconciliation.error, errorCode: reconciliation.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }, { outcomeState: 'unknown', errorCode: reconciliation.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }); }
            return;
        }
        if (!executionSerial && !canRunWithoutCurrentRoute) {
            const result = { success: false, error: 'Device is unreachable over USB/Wi-Fi ADB. Reconnect the headset or re-enable wireless debugging.', errorCode: 'DEVICE_UNAVAILABLE' };
            executionStore.fail(cmd.id, result.error, { errorCode: result.errorCode, claimToken: cmd.claim_token });
            return reportCommandStatus(cmd, 'failed', result, { errorCode: result.errorCode });
        }
        await reportCommandStatus(cmd, 'running', { state: 'running' }, { route: executionSerial });
        const commandRoute = executionSerial || targetStableSerial;
        const result = await worker.runCommand(commandRoute, cmd.type, cmd.payload, cmd);
        log('Command', `Finished ${cmd.type}#${cmd.id} on ${commandRoute}`, result);
        if (result.success) { executionStore.markEffectApplied(cmd.id, result); executionStore.complete(cmd.id, result, { claimToken: cmd.claim_token }); await reportCommandStatus(cmd, 'succeeded', result, { route: commandRoute }); }
        else if (result.unknown || (getCommandPolicy(cmd.type).dangerous && (result.timedOut || result.transportFailure))) { executionStore.markUnknown(cmd.id, result.error, { errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }); await reportCommandStatus(cmd, 'timeout', { success: false, error: result.error || 'Command outcome is unknown', errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }, { outcomeState: 'unknown', errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN', route: commandRoute }); }
        else { const failure = { success: false, error: result.error || 'Command failed', errorCode: result.errorCode || 'COMMAND_EXECUTION_FAILED' }; executionStore.fail(cmd.id, failure.error, { errorCode: failure.errorCode, claimToken: cmd.claim_token }); await reportCommandStatus(cmd, 'failed', failure, { errorCode: failure.errorCode, route: commandRoute }); }
    }

    async function syncWithCloud() {
        if (syncInFlight) return;
        syncInFlight = true;
        try {
            const activeSerials = await routing.getAdbDevices();
            const deviceDetails = await buildDeviceDetails(activeSerials);
            heartbeatStore.prune();
            const response = await cloud.sync({ active_serials: activeSerials, device_details: deviceDetails, agent_heartbeats: heartbeatStore.values(), hub_host: config.HUB_HOST, hub_port: Number(config.LOCAL_SERVER_PORT), hub_instance_id: config.HUB_INSTANCE_ID });
            const commands = response.json?.commands || [];
            log('Sync', `Cloud sync completed with ${commands.length} pending command(s)`, { activeSerials, heartbeats: heartbeatStore.values().length });
            await flushResultOutbox();
            await Promise.all(commands.map((command) => processCommand(command, activeSerials)));
        } catch (error) {
            log('Sync', 'Local Hub sync error', { error: error.message });
        } finally { syncInFlight = false; }
    }

    return Object.freeze({ bootstrapKnownDevices, syncWithCloud, flushResultOutbox, reportCommandStatus, get syncInFlight() { return syncInFlight; } });
}
