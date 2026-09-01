import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { terminateOwnedProcess } from '../cast-manager.js';
import { resolveApprovedApk } from '../apk-security.js';

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function createCommandDispatcher({ config, runner, routing, appDiscovery, credentialStore, provisioning, diagnostics, castRegistry, log = () => {}, spawnImpl = spawn } = {}) {
    const scrcpyProcesses = new Map();
    const isValidPackage = (value) => Boolean(value && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value));
    const isValidDeviceSerial = (value) => Boolean(value && config.DEVICE_SERIAL_REGEX.test(value));

    function safePayload(payload) {
        return Object.fromEntries(Object.entries(payload || {}).map(([key, value]) => /token|secret|credential/i.test(key) ? [key, '[REDACTED]'] : [key, value]));
    }
    function verifyCommandIdentity(command, executionSerial, stableSerial) {
        return (async () => {
            if (!executionSerial || !stableSerial) return { matched: false, error: 'DEVICE_IDENTITY_MISMATCH' };
            const expectedStable = String(command.target_stable_id || command.device_serial_number || stableSerial);
            const actualStable = await routing.getDeviceStableSerial(executionSerial);
            if (!actualStable || actualStable !== expectedStable) return { matched: false, error: `ADB route ${executionSerial} is ${actualStable || 'unknown'}, expected ${expectedStable}`, errorCode: 'DEVICE_IDENTITY_MISMATCH' };
            if (command.target_android_id) {
                const actualAndroid = await routing.getDeviceAndroidId(executionSerial);
                if (actualAndroid && actualAndroid !== String(command.target_android_id)) return { matched: false, error: `ADB route android_id ${actualAndroid} does not match command target`, errorCode: 'DEVICE_IDENTITY_MISMATCH' };
            }
            return { matched: true, actualStable };
        })();
    }

    async function wakeDevice(deviceSerial) {
        const executionSerial = await routing.resolveExecutionSerial(deviceSerial) || deviceSerial;
        log('Wake', `Attempting wake for ${deviceSerial} via ${executionSerial}`);
        const wakeResult = await runner.spawnAdb(['-s', executionSerial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 'Wake signal sent');
        if (!wakeResult.success) { log('Wake', `Wake keyevent failed for ${deviceSerial}`, { error: wakeResult.error }); return wakeResult; }
        const menuResult = await runner.spawnAdb(['-s', executionSerial, 'shell', 'input', 'keyevent', '82'], 'Wake unlock signal sent');
        if (!menuResult.success) { log('Wake', `Unlock keyevent failed for ${deviceSerial}`, { error: menuResult.error }); return wakeResult; }
        log('Wake', `Wake sequence completed for ${deviceSerial} via ${executionSerial}`);
        return wakeResult;
    }

    async function startAppComponent(deviceSerial, component) {
        if (!component) return { success: true, message: 'No explicit activity provided' };
        log('ADB', `Launching component ${component} on ${deviceSerial}`);
        return runner.spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', component], `Started ${component}`);
    }
    async function startAndVerifyApp(deviceSerial, component, expectedPackage) {
        const launch = await startAppComponent(deviceSerial, component);
        if (!launch.success) return launch;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            if (await diagnostics.getCurrentForegroundPackage(deviceSerial) === expectedPackage) return { ...launch, foreground_package: expectedPackage, launch_verified: true };
            await runner.delay(200);
        }
        return { success: false, error: `App launch was not verified: expected ${expectedPackage}, foreground is different`, errorCode: 'APP_LAUNCH_NOT_CONFIRMED', launch_verified: false };
    }

    async function dispatch(deviceSerial, commandType, payloadStr, commandMeta = {}) {
        let payload = {};
        try { payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr || '{}') : (payloadStr || {}); } catch {}
        log('Command', `Executing ${commandType} on ${deviceSerial}`, safePayload(payload));
        const { stableSerial, selectedRoute } = await routing.resolveRouteForCommand(deviceSerial, commandType, payload);
        const adbRoute = selectedRoute;
        if (!['RECONNECT_ADB', 'FORGET_DEVICE', 'RUN_DIAGNOSTICS'].includes(commandType) && !adbRoute) return { success: false, error: `No stable ADB route is available for ${stableSerial}`, errorCode: 'DEVICE_UNAVAILABLE' };
        if (adbRoute && commandMeta.id) {
            const identity = await verifyCommandIdentity(commandMeta, adbRoute, stableSerial);
            if (!identity.matched) { log('Command', `Refusing command ${commandMeta.id} on an unverified route`, { stableSerial, route: adbRoute, error: identity.error }); return { success: false, error: identity.error, errorCode: identity.errorCode || 'DEVICE_IDENTITY_MISMATCH', identityMismatch: true }; }
        }

        if (commandType === 'OPEN_SCRCPY') {
            if (castRegistry.has(stableSerial)) return { success: false, error: 'Browser cast already owns the Quest capture pipeline', errorCode: 'CAST_ALREADY_ACTIVE' };
            if (scrcpyProcesses.has(stableSerial)) return { success: true, message: 'scrcpy already running' };
            const args = ['-s', adbRoute, '-b', config.SCRCPY_BITRATE, `--max-size=${config.SCRCPY_MAX_SIZE}`, '--no-audio'];
            if (config.SCRCPY_CROP) args.push(`--crop=${config.SCRCPY_CROP}`);
            const scrcpy = spawnImpl(config.SCRCPY_EXECUTABLE, args);
            let settled = false;
            scrcpyProcesses.set(stableSerial, { process: scrcpy, route: adbRoute, startedAt: Date.now() });
            return new Promise((resolve) => {
                scrcpy.on('error', (error) => { log('scrcpy', error.message); if (scrcpyProcesses.get(stableSerial)?.process === scrcpy) scrcpyProcesses.delete(stableSerial); if (!settled) { settled = true; resolve({ success: false, error: `scrcpy could not start: ${error.message}`, errorCode: error.code === 'ENOENT' ? 'SCRCPY_NOT_FOUND' : 'SCRCPY_START_FAILED' }); } });
                scrcpy.on('spawn', () => { if (!settled) { settled = true; resolve({ success: true, message: 'scrcpy spawned' }); } });
                scrcpy.on('close', (code, signal) => { if (scrcpyProcesses.get(stableSerial)?.process === scrcpy) scrcpyProcesses.delete(stableSerial); if (code !== 0 && !settled) { settled = true; resolve({ success: false, error: `scrcpy exited before becoming usable${signal ? ` (${signal})` : ''}`, errorCode: 'SCRCPY_PROCESS_EXIT' }); } });
            });
        }
        if (commandType === 'CLOSE_SCRCPY') {
            const owned = scrcpyProcesses.get(stableSerial);
            if (!owned?.process) return { success: true, message: 'scrcpy not running' };
            await terminateOwnedProcess(owned.process, { termGraceMs: config.CAST_TERM_GRACE_MS, killGraceMs: config.CAST_KILL_GRACE_MS, log });
            if (scrcpyProcesses.get(stableSerial)?.process === owned.process) scrcpyProcesses.delete(stableSerial);
            return { success: true, message: 'scrcpy closed' };
        }
        if (commandType === 'START_SESSION') {
            const pkg = payload.package || config.QUEST_AGENT_PACKAGE;
            const activity = payload.activity || await appDiscovery.resolveLaunchComponent(adbRoute, pkg);
            const duration = payload.duration_minutes || 30;
            const wake = await wakeDevice(stableSerial);
            if (!wake.success) return wake;
            const notified = await runner.spawnAdb(provisioning.buildStartArgs(adbRoute, { action: 'START', pkg, activity, duration, sessionState: payload.session_state || null, autoLaunch: false }), `Agent notified for ${pkg}`);
            if (!notified.success) return notified;
            if (!activity) return { success: false, error: `Launch activity not found for ${pkg}` };
            const launched = await startAndVerifyApp(adbRoute, activity, pkg);
            return launched.success ? notified : launched;
        }
        if (commandType === 'PAUSE_SESSION') {
            const pkg = payload.package || payload.current_app_package;
            if (pkg && isValidPackage(pkg)) { const stop = await runner.spawnAdb(['-s', adbRoute, 'shell', 'am', 'force-stop', pkg], 'Package force-stopped'); if (!stop.success) return stop; }
            return runner.spawnAdb(provisioning.buildStartArgs(adbRoute, { action: 'PAUSE', pkg, sessionState: payload.session_state || null, autoLaunch: false }), 'Session paused in Agent');
        }
        if (commandType === 'RESUME_SESSION' || commandType === 'EXTEND_SESSION' || commandType === 'SWITCH_SESSION_APP') {
            const pkg = commandType === 'RESUME_SESSION'
                ? payload.current_app_package || payload.package || config.QUEST_AGENT_PACKAGE
                : payload.package || payload.current_app_package;
            const action = commandType === 'RESUME_SESSION' ? (payload.resync_only ? 'SYNC' : 'RESUME') : commandType === 'EXTEND_SESSION' ? 'SYNC' : (payload.launch_immediately ? 'SWITCH' : 'SYNC');
            const activity = action === 'SYNC' ? null : payload.activity || await appDiscovery.resolveLaunchComponent(adbRoute, pkg);
            const notified = await runner.spawnAdb(provisioning.buildStartArgs(adbRoute, { action, pkg, activity, sessionState: payload.session_state || null, autoLaunch: false }), `Agent synchronized session for ${pkg}`);
            if (!notified.success || action === 'SYNC') return notified;
            if (!activity) return { success: false, error: `Launch activity not found for ${pkg}` };
            const launched = await startAndVerifyApp(adbRoute, activity, pkg);
            return launched.success ? notified : launched;
        }
        if (commandType === 'END_SESSION') {
            const pkg = payload.package;
            if (!isValidPackage(pkg)) return { success: false, error: 'Invalid package name' };
            const stop = await runner.spawnAdb(['-s', adbRoute, 'shell', 'am', 'force-stop', pkg], 'Package force-stopped');
            if (!stop.success) return stop;
            await runner.delay(1000);
            const result = await runner.spawnAdb(provisioning.buildStartArgs(adbRoute, { action: 'STOP', sessionState: payload.session_state || null, autoLaunch: false }), 'Session ended, launcher started');
            if (!result.success) return result;
            const deadline = Date.now() + config.SESSION_CLEANUP_CONFIRM_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const foreground = await diagnostics.getCurrentForegroundPackage(adbRoute);
                const heartbeat = routing.findAgentHeartbeatForRoute({ stableSerial });
                if (foreground === config.QUEST_AGENT_PACKAGE && heartbeat && heartbeat.in_session === false && !heartbeat.session_id) return { ...result, cleanup_confirmed: true, foreground_package: foreground, agent_confirmed: true };
                await runner.delay(200);
            }
            return { success: false, error: 'Session cleanup could not be confirmed by foreground and Agent signals', errorCode: 'SESSION_CLEANUP_NOT_CONFIRMED', operator_required: true };
        }
        if (commandType === 'INSTALL_APP' || commandType === 'INSTALL_APK') {
            if (commandType === 'INSTALL_APK') {
                const agentPkg = payload.package_name || config.QUEST_AGENT_PACKAGE;
                if (!isValidPackage(agentPkg)) return { success: false, error: 'Invalid package name' };
                if (!payload.apk_checksum) return { success: false, error: 'Missing APK checksum in command payload' };
                if (payload.agent_token || payload.agentToken) return { success: false, error: 'Raw Agent credentials are not accepted in Cloud commands', errorCode: 'AGENT_CREDENTIAL_IN_COMMAND' };
                if (payload.target !== 'quest_agent' || payload.rotate_agent_credential !== true) return { success: false, error: 'Quest Agent provisioning intent is required', errorCode: 'AGENT_PROVISIONING_INTENT_REQUIRED' };
            }
            const artifactPayload = commandType === 'INSTALL_APK' ? { ...payload, artifact_id: payload.artifact_id || config.QUEST_AGENT_ARTIFACT_ID } : payload;
            const artifact = resolveApprovedApk(artifactPayload, { root: config.APK_ARTIFACT_ROOT, sha256File });
            if (artifact.error) return { success: false, error: artifact.error, errorCode: artifact.errorCode || 'APK_VALIDATION_FAILED' };
            const candidate = commandType === 'INSTALL_APK' ? credentialStore.create() : null;
            const installed = await runner.spawnAdb(['-s', adbRoute, 'install', '-r', artifact.path], commandType === 'INSTALL_APK' ? 'Installed Agent' : 'APK Installed');
            if (!installed.success || commandType !== 'INSTALL_APK') return installed;
            const started = await runner.spawnAdb(provisioning.buildStartArgs(adbRoute, { agentToken: candidate.token }), 'Started Agent installed');
            if (!started.success) return started;
            credentialStore.activate(stableSerial, payload, candidate);
            return { ...started, ...credentialStore.provisioningResult(candidate) };
        }
        if (commandType === 'UNINSTALL_APP') {
            const pkg = payload.package;
            if (!isValidPackage(pkg)) return { success: false, error: 'Invalid package name' };
            return runner.spawnAdb(['-s', adbRoute, 'uninstall', pkg], `Uninstalled ${pkg}`);
        }
        if (commandType === 'OPEN_LAUNCHER') return runner.spawnAdb(provisioning.buildStartArgs(adbRoute), 'Launcher started');
        if (commandType === 'REBOOT_DEVICE') return runner.spawnAdb(['-s', adbRoute, 'reboot'], 'Device rebooting');
        if (commandType === 'REFRESH_STATUS') {
            if (payload.wake_device) { const result = await wakeDevice(stableSerial); if (!result.success) return result; await runner.delay(1000); return { success: true, message: 'device awakened and status refresh scheduled' }; }
            if (payload.repair_wireless) {
                try {
                    const usbSerial = payload.usb_serial || routing.routes[stableSerial]?.usbSerial || stableSerial;
                    const repairStableSerial = payload.stable_serial || await routing.getDeviceStableSerial(usbSerial);
                    const wifiDetails = await routing.getDeviceWifiDetails(usbSerial);
                    routing.rememberWirelessRoute(repairStableSerial, { usbSerial, ip: wifiDetails.ip, wifiSsid: wifiDetails.wifiSsid ?? null, androidId: await routing.getDeviceAndroidId(usbSerial), model: await routing.getDeviceModel(usbSerial), knownDevice: true });
                    void routing.setupWirelessAdb(repairStableSerial, wifiDetails, { force: true, usbSerial }).catch((error) => log('WirelessADB', `USB repair failed: ${error.message}`));
                    await runner.delay(1200);
                    return { success: true, message: 'USB repair started. Local Hub will reconnect Wi-Fi ADB.' };
                } catch (error) { return { success: false, error: `USB repair failed: ${error.message}` }; }
            }
            await runner.delay(1000);
            return { success: true, message: 'status refreshed' };
        }
        if (commandType === 'RECONNECT_ADB') {
            const reconnectStable = payload.stable_serial || stableSerial;
            const route = routing.routes[reconnectStable] || { stableSerial: reconnectStable, ip: routing.wirelessStateIndex[reconnectStable]?.ip || null, wirelessSerial: routing.wirelessStateIndex[reconnectStable]?.wirelessSerial || null, androidId: routing.wirelessStateIndex[reconnectStable]?.androidId || null, agentOnline: Boolean(routing.findAgentHeartbeatForRoute({ stableSerial: reconnectStable })) };
            const result = await routing.supervisor.forceReconnect(reconnectStable, { route, heartbeatIp: routing.findAgentHeartbeatForRoute(route)?.local_ip || null });
            await routing.refreshDeviceRouting(false);
            return result?.status === 'online' ? { success: true, message: 'ADB reconnect attempted using remembered Wi-Fi routes' } : { success: false, error: result?.lastError || 'No remembered Wi-Fi route could be reconnected. Connect USB and run Repair via USB.' };
        }
        if (commandType === 'RELAUNCH_AGENT') {
            const route = await routing.resolveExecutionSerial(stableSerial) || adbRoute;
            if (!isValidDeviceSerial(route)) return { success: false, error: 'No valid ADB route is available to relaunch Quest Agent' };
            return runner.spawnAdb(provisioning.buildStartArgs(route), 'Quest Agent relaunched');
        }
        if (commandType === 'RUN_DIAGNOSTICS') {
            await routing.refreshDeviceRouting(false);
            const route = routing.routes[stableSerial] || Object.values(routing.routes).find((entry) => entry.executionSerial === stableSerial);
            if (!route) return { success: false, error: 'Device route not found for diagnostics' };
            route.agentOnline = Boolean(routing.findAgentHeartbeatForRoute(route));
            const health = routing.summarizeRouteHealth(route);
            return { success: true, message: JSON.stringify({ connection_status: health.connection_status, what_works: { adb: health.adb_status === 'online', agent: health.agent_status === 'online', wifi_ready: health.wifi_ready }, probable_cause: health.status_reason, next_step: health.next_step }) };
        }
        if (commandType === 'FORGET_DEVICE') {
            const forgottenSerial = payload.stable_serial || deviceSerial;
            const agentId = payload.agent_id || null;
            const ignoredTransportId = routing.routes[forgottenSerial]?.transportId || null;
            routing.wirelessStateIndex[forgottenSerial] = { stableSerial: forgottenSerial, agentId, ignored: true, ignoredAt: Date.now(), ignoredTransportId, readyForRediscovery: false };
            routing.saveWirelessState();
            delete routing.routes[forgottenSerial];
            routing.supervisor.forget?.(forgottenSerial);
            if (agentId) routing.forgetHeartbeat?.(agentId);
            return { success: true, message: `Forgot remembered Quest ${forgottenSerial}` };
        }
        return { success: false, error: 'unknown command' };
    }

    return Object.freeze({ dispatch, wakeDevice, scrcpyProcesses });
}
