import net from 'node:net';
import { createAdbSupervisor } from '../adb-supervisor.js';
import { checkAdbRecoveryPermission, reportAdbRecoveryStatus, tryEnableWirelessAdb } from '../adb-recovery-adapter.js';
import { selectPreferredExecutionRoute, prefersUsbForCommand } from '../route-selection.js';
import { createJsonStore } from '../storage.js';
import { toWirelessSerial } from '../config.js';

function normalizeIpList(items) {
    return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function isTcpAdbSerial(value) {
    return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(String(value || '').trim());
}

function parseAdbDevices(output) {
    return output.split('\n').slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/).filter(Boolean);
        const meta = {};
        for (const token of parts.slice(2)) {
            const idx = token.indexOf(':');
            if (idx > 0) meta[token.slice(0, idx)] = token.slice(idx + 1);
        }
        return { serial: parts[0], status: parts[1] || 'unknown', transportId: meta.transport_id || null, usbBus: meta.usb || null };
    });
}

export function createDeviceRouter({ config, runAdbCapture, heartbeatStore, log = () => {}, getScrcpyProcesses = () => new Map(), onStaleCastRoute = () => {} } = {}) {
    const wirelessStore = createJsonStore(config.WIRELESS_STATE_PATH, { fallback: {} });
    const wirelessStateIndex = wirelessStore.get();
    const routes = {};
    const adbCommandMetricsByStableSerial = new Map();

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isAdbRouteOnline = async (serial) => {
        if (!serial) return false;
        try { return (await runAdbCapture(['-s', serial, 'get-state'])).trim() === 'device'; } catch { return false; }
    };
    const getDeviceStableSerial = async (serial) => {
        try { return (await runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.serialno'])).trim() || serial; } catch { return null; }
    };
    const getDeviceAndroidId = async (serial) => {
        try { return (await runAdbCapture(['-s', serial, 'shell', 'settings', 'get', 'secure', 'android_id'])).trim() || null; } catch { return null; }
    };
    const getDeviceModel = async (serial) => {
        try { return (await runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.product.model'])).trim() || 'Meta Quest'; } catch { return 'Meta Quest'; }
    };
    const getDeviceWifiDetails = async (serial) => {
        const details = { ip: null, wifiSsid: null };
        try {
            const out = await runAdbCapture(['-s', serial, 'shell', 'ip', 'addr', 'show', 'wlan0']);
            const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            if (match) details.ip = match[1];
        } catch {}
        try {
            const wifiStatus = await runAdbCapture(['-s', serial, 'shell', 'cmd', 'wifi', 'status']);
            const ssidMatch = wifiStatus.match(/SSID:\s+"([^"]+)"/) || wifiStatus.match(/SSID:\s+([^\n,]+)/);
            if (ssidMatch) details.wifiSsid = ssidMatch[1].trim().replace(/^"|"$/g, '');
        } catch {}
        return details;
    };

    function saveWirelessState() { wirelessStore.save(); }
    function pushPreviousIps(state, nextIp) { return normalizeIpList([nextIp, ...(state?.previousIps || []), state?.ip]).slice(0, 8); }
    function rememberWirelessRoute(stableSerial, updates) {
        const previous = wirelessStateIndex[stableSerial] || {};
        const nextIp = updates.ip || previous.ip || null;
        wirelessStateIndex[stableSerial] = {
            ...previous, stableSerial, ...updates,
            previousIps: normalizeIpList([...(updates.previousIps || []), ...pushPreviousIps(previous, nextIp)]).slice(0, 8),
            lastSeenAt: Date.now(),
        };
        saveWirelessState();
    }

    function mergeWirelessStateEntries(primaryKey, aliasKey) {
        if (!primaryKey || !aliasKey || primaryKey === aliasKey) return primaryKey;
        const primary = wirelessStateIndex[primaryKey] || {};
        const alias = wirelessStateIndex[aliasKey] || {};
        wirelessStateIndex[primaryKey] = {
            ...alias, ...primary, stableSerial: primaryKey,
            usbSerial: primary.usbSerial || alias.usbSerial || null,
            wirelessSerial: primary.wirelessSerial || alias.wirelessSerial || null,
            ip: primary.ip || alias.ip || null,
            wifiSsid: primary.wifiSsid || alias.wifiSsid || null,
            agentId: primary.agentId || alias.agentId || null,
            androidId: primary.androidId || alias.androidId || null,
            model: primary.model || alias.model || 'Meta Quest',
            previousIps: normalizeIpList([...(primary.previousIps || []), ...(alias.previousIps || []), primary.ip, alias.ip]).slice(0, 8),
            lastSeenAt: Math.max(Number(primary.lastSeenAt || 0), Number(alias.lastSeenAt || 0), Date.now()),
        };
        delete wirelessStateIndex[aliasKey];
        saveWirelessState();
        return primaryKey;
    }

    async function findCanonicalStableSerialForState(stableSerial, state) {
        if (!stableSerial || !state || !isTcpAdbSerial(stableSerial)) return stableSerial;
        if (state.usbSerial && !isTcpAdbSerial(state.usbSerial)) return state.usbSerial;
        const sibling = Object.entries(wirelessStateIndex).find(([key, entry]) => key !== stableSerial && !isTcpAdbSerial(key) && (
            (entry?.wirelessSerial && state.wirelessSerial && entry.wirelessSerial === state.wirelessSerial) ||
            (entry?.ip && state.ip && entry.ip === state.ip) ||
            (entry?.agentId && state.agentId && entry.agentId === state.agentId)
        ));
        if (sibling) return sibling[0];
        if (state.wirelessSerial) {
            const liveStable = await getDeviceStableSerial(state.wirelessSerial);
            if (liveStable && !isTcpAdbSerial(liveStable)) return liveStable;
        }
        return stableSerial;
    }

    async function collapseWirelessStateAliases() {
        let changed = false;
        for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
            const canonical = await findCanonicalStableSerialForState(stableSerial, state);
            if (canonical && canonical !== stableSerial) { mergeWirelessStateEntries(canonical, stableSerial); changed = true; }
        }
        if (changed) saveWirelessState();
    }

    function clearIgnoredDevice(stableSerial) {
        if (!stableSerial || !wirelessStateIndex[stableSerial]?.ignored) return;
        wirelessStateIndex[stableSerial] = { ...wirelessStateIndex[stableSerial], ignored: false, ignoredAt: null, readyForRediscovery: false };
        saveWirelessState();
    }
    function isIgnoredDevice(stableSerial, agentId = null) {
        const state = stableSerial ? wirelessStateIndex[stableSerial] : null;
        if (state?.ignored && !state?.readyForRediscovery) return true;
        if (!agentId) return false;
        return Object.values(wirelessStateIndex).some((entry) => entry?.ignored && entry?.agentId && entry.agentId === agentId);
    }
    function shouldKeepIgnoredDevice(stableSerial, transportId = null) {
        const state = stableSerial ? wirelessStateIndex[stableSerial] : null;
        if (!state?.ignored || state.readyForRediscovery) return false;
        if (!state.ignoredTransportId) return true;
        return String(state.ignoredTransportId) === String(transportId || '');
    }

    async function listAdbDevicesDetailed() {
        try { return parseAdbDevices(await runAdbCapture(['devices', '-l'])); }
        catch (error) { log('ADB', 'ADB device discovery failed', { error: error.message, category: error?.timedOut ? 'process_timeout' : 'adb_error' }); return []; }
    }

    function checkRoutePortOpen(ip, port) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let settled = false;
            const finish = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
            socket.setTimeout(1500);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
            socket.connect(port, ip);
        });
    }

    async function adbConnect(serial) {
        try {
            const message = await runAdbCapture(['connect', serial]);
            const normalized = String(message).toLowerCase();
            if (!(normalized.includes('connected to') || normalized.includes('already connected to'))) return { success: false, message: String(message).trim() || `ADB connect failed for ${serial}.` };
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (await isAdbRouteOnline(serial)) return { success: true, message: String(message).trim() };
                await delay(250);
            }
            return { success: false, message: `Connected ${serial} but adb get-state did not stabilize.` };
        } catch (error) { return { success: false, message: error.message }; }
    }
    async function adbDisconnect(serial) {
        try { await runAdbCapture(['disconnect', serial]); return { success: true }; } catch (error) { return { success: false, message: error.message }; }
    }

    const supervisor = createAdbSupervisor({
        port: config.WIRELESS_ADB_PORT,
        log,
        getKnownState: (stableSerial) => wirelessStateIndex[stableSerial] || {},
        rememberRoute: rememberWirelessRoute,
        checkRoutePortOpen,
        adbDisconnect,
        adbConnect,
        verifyRouteIdentity: async ({ serial, expectedStableId, expectedAndroidId }) => {
            const stableId = await getDeviceStableSerial(serial) || null;
            const androidId = await getDeviceAndroidId(serial) || null;
            return {
                matched: (expectedStableId ? stableId === expectedStableId : true) && (expectedAndroidId ? androidId === expectedAndroidId : true),
                stableId, androidId,
                message: `ADB route ${serial} resolved to stable_id=${stableId || 'unknown'} android_id=${androidId || 'unknown'}`,
            };
        },
        checkAdbRecoveryPermission,
        tryEnableWirelessAdb,
    });

    async function connectWirelessTarget(stableSerial, force = false) {
        const state = wirelessStateIndex[stableSerial];
        if (state?.ignored) return false;
        const route = routes[stableSerial] || { stableSerial, ip: state?.ip || null, wirelessSerial: state?.wirelessSerial || null, androidId: state?.androidId || null, agentOnline: Boolean(heartbeatStore.findForRoute({ stableSerial, agentId: state?.agentId, androidId: state?.androidId })) };
        const heartbeat = heartbeatStore.findForRoute(route);
        const result = force
            ? await supervisor.forceReconnect(stableSerial, { route, heartbeatIp: heartbeat?.local_ip || null, force: true, reason: 'explicit_route_repair' })
            : await supervisor.tick({ ...route, adbState: 'offline' }, { route, heartbeatIp: heartbeat?.local_ip || null, force: false, reason: 'discovery_recovery' });
        return result?.status === 'online';
    }

    async function setupWirelessAdb(stableSerial, wifiDetails, options = {}) {
        if (!config.ENABLE_WIRELESS_ADB || !wifiDetails?.ip) return;
        const state = wirelessStateIndex[stableSerial] || {};
        const usbSerial = options.usbSerial || state.usbSerial || stableSerial;
        if (!options.force && (Date.now() - Number(state.lastSetupAttemptAt || 0)) < config.WIRELESS_SETUP_RETRY_MS) return;
        rememberWirelessRoute(stableSerial, { usbSerial, ip: wifiDetails.ip, wifiSsid: wifiDetails.wifiSsid ?? null, wirelessSerial: toWirelessSerial(wifiDetails.ip, config.WIRELESS_ADB_PORT), lastSetupAttemptAt: Date.now() });
        log('Wireless ADB', `Enabling TCP/IP for ${stableSerial} via ${usbSerial} on ${wifiDetails.ip}:${config.WIRELESS_ADB_PORT}`);
        try { await runAdbCapture(['-s', usbSerial, 'tcpip', String(config.WIRELESS_ADB_PORT)]); }
        catch (error) { log('Wireless ADB', `tcpip setup failed for ${stableSerial}`, { error: error.message }); return; }
        await connectWirelessTarget(stableSerial, true);
    }

    async function getRouteOnlineState(route, cache = new Map()) {
        const read = async (serial) => {
            if (!serial) return false;
            if (!cache.has(serial)) cache.set(serial, await isAdbRouteOnline(serial));
            return Boolean(cache.get(serial));
        };
        return { usbOnline: await read(route.usbSerial), wirelessOnline: await read(route.wirelessSerial) };
    }
    async function chooseExecutionRoute(route, purpose = 'control', cache = new Map()) {
        const state = await getRouteOnlineState(route, cache);
        return selectPreferredExecutionRoute({ usbSerial: route.usbSerial || null, wirelessSerial: route.wirelessSerial || null, usbOnline: state.usbOnline, wirelessOnline: state.wirelessOnline }, { purpose });
    }

    function summarizeRouteHealth(route, cachedState = null) {
        const state = cachedState || wirelessStateIndex[route.stableSerial] || null;
        const supervisorState = supervisor.getState(route.stableSerial) || null;
        const currentIp = route.ip || state?.ip || null;
        const ipChanged = Boolean(route.ip && state?.ip && route.ip !== state.ip);
        const hasWirelessRoute = Boolean(currentIp);
        const isConnectedOverWifi = Boolean(route.executionSerial && route.executionSerial.includes(':'));
        const usbAvailable = route.usbOnlineSnapshot === true;
        const agentOnline = Boolean(route.agentOnline);
        const agentKnown = Boolean(route.agentId || route.pairingId || state?.agentId);
        const unauthorized = route.adbState === 'unauthorized';
        const previousIps = normalizeIpList([currentIp, ...(state?.previousIps || [])]);
        const adbRecovery = supervisorState?.recovery || reportAdbRecoveryStatus();
        const degraded = { reconnecting: 'reconnecting', tcpip_unavailable: 'tcpip_unavailable', port_closed: 'port_closed', different_device: 'different_device', unauthorized: 'unauthorized' }[supervisorState?.status] || (hasWirelessRoute ? 'offline' : 'unavailable');
        if (unauthorized) return { adb_status: 'unauthorized', agent_status: agentOnline ? 'online' : 'offline', connection_status: 'usb_unauthorized', transport: 'usb', wifi_ready: false, usb_repair_required: true, status_reason: 'Quest is connected over USB, but ADB authorization is still waiting on the headset.', next_step: 'Put on the headset, allow USB debugging, then run pairing again.', wake_supported: false, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: ipChanged, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        if (isConnectedOverWifi && agentOnline) return { adb_status: 'online', agent_status: 'online', connection_status: 'online', transport: 'wifi', wifi_ready: true, usb_repair_required: false, status_reason: ipChanged ? `Wi-Fi ADB reconnected. Device IP changed to ${route.ip}.` : 'Wi-Fi ADB is connected and ready for wake/session commands.', next_step: 'Quest is ready for sessions.', wake_supported: true, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: ipChanged, adb_recovery_status: 'ready', adb_recovery_permission: adbRecovery.permission };
        if (isConnectedOverWifi) return { adb_status: 'online', agent_status: agentKnown ? 'offline' : 'unknown', connection_status: 'wifi_ready', transport: 'wifi', wifi_ready: true, usb_repair_required: false, status_reason: 'Wi-Fi ADB is online, but Quest Agent heartbeat is missing.', next_step: 'Start or reinstall Quest Agent from the operator panel.', wake_supported: true, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: ipChanged, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        if (usbAvailable && hasWirelessRoute && agentOnline) return { adb_status: 'online', agent_status: 'online', connection_status: 'pairing_in_progress', transport: 'usb', wifi_ready: false, usb_repair_required: false, status_reason: ipChanged ? `USB connected. Wi-Fi IP changed to ${route.ip}; Local Hub will refresh wireless routing.` : 'USB is connected. Local Hub can refresh the Wi-Fi ADB route for cable-free control.', next_step: 'Wait for wireless ADB to reconnect or run USB Repair once.', wake_supported: false, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: ipChanged, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        if (usbAvailable) return { adb_status: 'online', agent_status: agentOnline ? 'online' : 'offline', connection_status: agentOnline ? 'pairing_in_progress' : 'adb_online_agent_offline', transport: 'usb', wifi_ready: false, usb_repair_required: false, status_reason: hasWirelessRoute ? 'USB is connected. Local Hub can refresh Wi-Fi ADB and verify Quest Agent.' : 'USB is connected. Finish first pairing to enable stable wireless recovery.', next_step: hasWirelessRoute ? 'Use USB Repair to refresh the wireless route and recheck Agent.' : 'Assign the headset to a room, install Quest Agent, then enable Wi-Fi ADB.', wake_supported: false, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: ipChanged, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        if (agentOnline) return { adb_status: degraded, agent_status: 'online', connection_status: 'agent_online_adb_offline', transport: 'agent_only', wifi_ready: false, usb_repair_required: hasWirelessRoute, status_reason: supervisorState?.lastError ? `Quest Agent heartbeat is arriving, but ADB recovery is blocked: ${supervisorState.lastError}` : 'Quest Agent heartbeat is arriving, but ADB is offline.', next_step: degraded === 'reconnecting' ? 'Local Hub is retrying saved Wi-Fi routes with backoff. Leave the headset on club Wi-Fi.' : degraded === 'different_device' ? 'ADB connected to a different Quest on the remembered route. Reconnect USB once to refresh the trusted identity.' : degraded === 'tcpip_unavailable' ? 'Wireless debugging is not answering on port 5555. Use USB Repair or future secure-settings recovery.' : degraded === 'port_closed' ? 'The remembered Quest IP is reachable, but port 5555 is closed. Re-enable wireless ADB with USB Repair.' : 'Use USB Repair to restore Wi-Fi ADB without creating the headset again.', wake_supported: false, wifi_ip: currentIp, previous_ips: previousIps, ip_changed: false, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        if (hasWirelessRoute) return { adb_status: degraded, agent_status: agentKnown ? 'offline' : 'unknown', connection_status: state?.hadSuccessfulWifiConnection ? 'vpn_or_lan_blocked' : 'offline_sleeping', transport: 'disconnected', wifi_ready: false, usb_repair_required: Boolean(state?.hadSuccessfulWifiConnection), status_reason: supervisorState?.lastError || (state?.hadSuccessfulWifiConnection ? `Quest is known, but the saved Wi-Fi ADB route ${currentIp}:${config.WIRELESS_ADB_PORT} is unreachable.` : `Remembered Wi-Fi route ${currentIp}:${config.WIRELESS_ADB_PORT} is saved. Local Hub is still trying to reconnect.`), next_step: degraded === 'reconnecting' ? 'Local Hub is retrying last known IPs and heartbeat routes.' : degraded === 'different_device' ? 'The remembered Wi-Fi route points at another device. Reconnect USB and refresh the wireless route.' : state?.hadSuccessfulWifiConnection ? 'Possible causes: VPN blocks the LAN, IP changed, or wireless debugging was reset. Connect USB and run USB Repair.' : 'Leave the headset awake on club Wi-Fi or reconnect USB once to finish setup.', wake_supported: Boolean(!state?.hadSuccessfulWifiConnection), wifi_ip: currentIp, previous_ips: previousIps, ip_changed: false, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
        return { adb_status: 'unavailable', agent_status: 'unknown', connection_status: route.knownDevice ? 'usb_pairing_required' : 'new', transport: 'disconnected', wifi_ready: false, usb_repair_required: true, status_reason: route.knownDevice ? 'Quest identity is known, but there is no active USB or Wi-Fi ADB route.' : 'Wireless ADB is not configured yet. Connect this Quest over trusted USB first.', next_step: route.knownDevice ? 'Connect the headset over USB and run USB Repair. Do not add it again.' : 'Connect the headset over USB to start first pairing.', wake_supported: false, wifi_ip: null, previous_ips: previousIps, ip_changed: false, adb_recovery_status: adbRecovery.status, adb_recovery_permission: adbRecovery.permission };
    }

    async function refreshDeviceRouting(allowWirelessSetup = true) {
        await collapseWirelessStateAliases();
        const adbDevices = (await listAdbDevicesDetailed()).filter((entry) => ['device', 'unauthorized'].includes(entry.status));
        const justConnectedRoutes = [];
        const nextRoutes = new Map();
        const seenStableSerials = new Set();
        const wirelessByIp = new Map(adbDevices.filter((entry) => entry.serial.includes(':') && entry.status === 'device').map((entry) => [entry.serial.split(':')[0], entry.serial]));
        for (const entry of adbDevices) {
            const serial = entry.serial;
            if (serial.includes(':') || serial.startsWith('emulator-')) continue;
            const stableSerial = entry.status === 'device' ? await getDeviceStableSerial(serial) : serial;
            seenStableSerials.add(stableSerial);
            const wifiDetails = entry.status === 'device' ? await getDeviceWifiDetails(serial) : { ip: null, wifiSsid: null };
            const state = wirelessStateIndex[stableSerial] || {};
            if (shouldKeepIgnoredDevice(stableSerial, entry.transportId)) continue;
            if (state.ignored) clearIgnoredDevice(stableSerial);
            const route = { stableSerial, executionSerial: entry.status === 'device' ? serial : null, usbSerial: serial, usbOnlineSnapshot: entry.status === 'device', wirelessOnlineSnapshot: false, wirelessSerial: state.wirelessSerial || (state.ip ? toWirelessSerial(state.ip, config.WIRELESS_ADB_PORT) : null), ip: wifiDetails.ip || state.ip || null, wifiSsid: wifiDetails.wifiSsid || state.wifiSsid || null, lastVerifiedWirelessAt: Number(state.lastVerifiedWirelessAt || 0), adbState: entry.status === 'unauthorized' ? 'unauthorized' : 'online', transportId: entry.transportId || null, androidId: entry.status === 'device' ? await getDeviceAndroidId(serial) : state.androidId || null, model: entry.status === 'device' ? await getDeviceModel(serial) : state.model || 'Meta Quest', agentId: state.agentId || null, pairingId: state.agentId || null, knownDevice: Boolean(state.knownDevice || state.agentId || state.ip || state.previousIps?.length) };
            if (wifiDetails.ip) {
                const wirelessSerial = wirelessByIp.get(wifiDetails.ip) || toWirelessSerial(wifiDetails.ip, config.WIRELESS_ADB_PORT);
                route.wirelessSerial = wirelessSerial;
                rememberWirelessRoute(stableSerial, { usbSerial: serial, ip: wifiDetails.ip, wifiSsid: wifiDetails.wifiSsid ?? null, wirelessSerial, androidId: route.androidId, model: route.model });
                if (!wirelessByIp.has(wifiDetails.ip) && allowWirelessSetup) void setupWirelessAdb(stableSerial, wifiDetails, { usbSerial: serial });
            } else if (route.wirelessSerial && await isAdbRouteOnline(route.wirelessSerial)) route.executionSerial = route.wirelessSerial;
            nextRoutes.set(stableSerial, route);
        }
        for (const entry of adbDevices.filter((item) => item.serial.includes(':') && item.status === 'device')) {
            const ip = entry.serial.split(':')[0];
            const liveStableSerial = await getDeviceStableSerial(entry.serial);
            const resolvedStableSerial = liveStableSerial && !isTcpAdbSerial(liveStableSerial) ? liveStableSerial : null;
            if (!resolvedStableSerial) { log('Routing', 'Ignoring wireless ADB route without verified identity', { route: entry.serial, ip }); continue; }
            seenStableSerials.add(resolvedStableSerial);
            if (isIgnoredDevice(resolvedStableSerial)) continue;
            const existing = nextRoutes.get(resolvedStableSerial);
            if (existing) {
                existing.wirelessSerial = entry.serial; existing.executionSerial = entry.serial; existing.wirelessOnlineSnapshot = true; existing.ip = existing.ip || ip; existing.adbState = 'online'; existing.transportId = entry.transportId || existing.transportId || null;
            } else {
                const state = wirelessStateIndex[resolvedStableSerial] || {};
                nextRoutes.set(resolvedStableSerial, { stableSerial: resolvedStableSerial, executionSerial: entry.serial, usbSerial: state.usbSerial || null, usbOnlineSnapshot: false, wirelessOnlineSnapshot: true, wirelessSerial: entry.serial, ip, wifiSsid: state.wifiSsid || null, adbState: 'online', transportId: entry.transportId || null, androidId: state.androidId || null, model: state.model || 'Meta Quest', agentId: state.agentId || null, pairingId: state.agentId || null, knownDevice: true });
            }
            const route = nextRoutes.get(resolvedStableSerial);
            rememberWirelessRoute(resolvedStableSerial, { ip, wirelessSerial: entry.serial, usbSerial: route?.usbSerial || wirelessStateIndex[resolvedStableSerial]?.usbSerial || null, androidId: await getDeviceAndroidId(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.androidId || null, model: await getDeviceModel(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.model || 'Meta Quest', hadSuccessfulWifiConnection: true });
        }
        if (config.ENABLE_WIRELESS_ADB) {
            for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
                if (!state?.ip || state.ignored || nextRoutes.has(stableSerial)) continue;
                if (await connectWirelessTarget(stableSerial, false)) justConnectedRoutes.push({ stableSerial, ip: state.ip, wirelessSerial: state.wirelessSerial || toWirelessSerial(state.ip, config.WIRELESS_ADB_PORT) });
            }
        }
        for (const route of justConnectedRoutes) nextRoutes.set(route.stableSerial, { stableSerial: route.stableSerial, executionSerial: route.wirelessSerial, usbSerial: wirelessStateIndex[route.stableSerial]?.usbSerial || null, usbOnlineSnapshot: false, wirelessOnlineSnapshot: true, wirelessSerial: route.wirelessSerial, ip: route.ip, wifiSsid: wirelessStateIndex[route.stableSerial]?.wifiSsid || null, adbState: 'online', androidId: wirelessStateIndex[route.stableSerial]?.androidId || null, model: wirelessStateIndex[route.stableSerial]?.model || 'Meta Quest', agentId: wirelessStateIndex[route.stableSerial]?.agentId || null, pairingId: wirelessStateIndex[route.stableSerial]?.agentId || null, knownDevice: true });
        for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
            if (state?.ignored || nextRoutes.has(stableSerial)) continue;
            nextRoutes.set(stableSerial, { stableSerial, executionSerial: null, usbSerial: state.usbSerial || null, usbOnlineSnapshot: false, wirelessOnlineSnapshot: false, wirelessSerial: state.wirelessSerial || (state.ip ? toWirelessSerial(state.ip, config.WIRELESS_ADB_PORT) : null), ip: state.ip || null, wifiSsid: state.wifiSsid || null, adbState: 'offline', androidId: state.androidId || null, model: state.model || 'Meta Quest', agentId: state.agentId || null, pairingId: state.agentId || null, knownDevice: true });
        }
        for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
            if (!state?.ignored || seenStableSerials.has(stableSerial) || state.readyForRediscovery) continue;
            wirelessStateIndex[stableSerial] = { ...state, readyForRediscovery: true }; saveWirelessState();
        }
        const onlineStateCache = new Map();
        for (const route of nextRoutes.values()) { route.executionSerial = await chooseExecutionRoute(route, 'control', onlineStateCache); if (route.adbState !== 'unauthorized') route.adbState = route.executionSerial ? 'online' : 'offline'; }
        for (const [stableSerial, owner] of getScrcpyProcesses().entries()) {
            const nextRoute = nextRoutes.get(stableSerial)?.executionSerial;
            if (nextRoute && owner.route && nextRoute !== owner.route) onStaleCastRoute(stableSerial, owner, nextRoute);
        }
        for (const [key, value] of nextRoutes) routes[key] = value;
        for (const key of Object.keys(routes)) if (!nextRoutes.has(key)) delete routes[key];
        for (const route of Object.values(routes)) void supervisor.tick(route, { route });
        log('Routing', 'Resolved device routes', Object.values(routes).map((route) => ({ stableSerial: route.stableSerial, executionSerial: route.executionSerial, usbSerial: route.usbSerial, wirelessSerial: route.wirelessSerial, ip: route.ip })));
        return Object.values(routes);
    }

    async function resolveExecutionSerial(stableSerial) {
        const route = routes[stableSerial];
        if (route?.executionSerial && await isAdbRouteOnline(route.executionSerial)) return route.executionSerial;
        await refreshDeviceRouting(false);
        const refreshed = routes[stableSerial];
        if (refreshed?.executionSerial && await isAdbRouteOnline(refreshed.executionSerial)) return refreshed.executionSerial;
        if (wirelessStateIndex[stableSerial]?.ip && await connectWirelessTarget(stableSerial, true)) {
            await refreshDeviceRouting(false);
            const reconnected = routes[stableSerial];
            if (reconnected?.executionSerial && await isAdbRouteOnline(reconnected.executionSerial)) return reconnected.executionSerial;
        }
        return null;
    }
    function resolveStableSerial(routeKey) {
        if (routes[routeKey]) return routeKey;
        return Object.values(routes).find((route) => route.executionSerial === routeKey || route.wirelessSerial === routeKey || route.usbSerial === routeKey)?.stableSerial || routeKey;
    }
    async function resolveRouteForCommand(routeKey, commandType, payload = {}) {
        const stableSerial = resolveStableSerial(routeKey);
        const route = routes[stableSerial];
        const purpose = prefersUsbForCommand(commandType, payload) ? 'maintenance' : 'control';
        const selectedRoute = route ? await chooseExecutionRoute(route, purpose) : null;
        return { stableSerial, selectedRoute: selectedRoute || (purpose === 'control' ? await resolveExecutionSerial(stableSerial) : null) };
    }
    async function getAdbDevices() { return (await refreshDeviceRouting(true)).filter((route) => Boolean(route.executionSerial) || route.adbState === 'unauthorized').map((route) => route.stableSerial); }

    return Object.freeze({
        routes,
        wirelessStateIndex,
        supervisor,
        adbCommandMetricsByStableSerial,
        getDeviceStableSerial,
        getDeviceAndroidId,
        getDeviceModel,
        getDeviceWifiDetails,
        runAdbCapture,
        isAdbRouteOnline,
        rememberWirelessRoute,
        saveWirelessState,
        clearIgnoredDevice,
        isIgnoredDevice,
        summarizeRouteHealth,
        setupWirelessAdb,
        connectWirelessTarget,
        refreshDeviceRouting,
        resolveExecutionSerial,
        resolveStableSerial,
        resolveRouteForCommand,
        getAdbDevices,
        findAgentHeartbeatForRoute: heartbeatStore.findForRoute,
        forgetHeartbeat: heartbeatStore.forget,
        getState() { return routes; },
    });
}
