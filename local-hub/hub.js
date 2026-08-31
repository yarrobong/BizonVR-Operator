import https from 'https';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { buildHeartbeatIdentity, prefersUsbForCommand, selectPreferredExecutionRoute } from './route-selection.js';
import { createAdbSupervisor } from './adb-supervisor.js';
import { checkAdbRecoveryPermission, reportAdbRecoveryStatus, tryEnableWirelessAdb } from './adb-recovery-adapter.js';
import {
    buildAdbScreenrecordArgs,
    buildFfmpegArgs,
    createStreamStopper,
    getFallbackResponseStrategy,
    getStreamProfile,
    isResponseWritable,
    resolveStreamRequest,
    safeEnd,
    safeWrite,
    safeWriteHead,
} from './streaming.js';
import { DEFAULT_CAST_PROFILE, DEFAULT_CAST_TRANSPORT } from '../src/shared/cast-config.js';

const HUB_ID = 1;
const API_URL = process.env.APP_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 5000;
const LOCAL_SERVER_PORT = process.env.HUB_PORT || 3001;
const HUB_HOST = resolveHubHost();
const HUB_TOKEN = process.env.HUB_TOKEN || '';
const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || 'com.bizonvr.spatialspike';
const QUEST_AGENT_MAIN_ACTIVITY = process.env.QUEST_AGENT_MAIN_ACTIVITY || '.SpatialLauncherActivity';
const QUEST_AGENT_APK_PATH = resolveQuestAgentApkPath();
const ENABLE_WIRELESS_ADB = process.env.ENABLE_WIRELESS_ADB === '1';
const SCRCPY_MAX_SIZE = process.env.SCRCPY_MAX_SIZE || '1600';
const SCRCPY_BITRATE = process.env.SCRCPY_BITRATE || '25M';
const SCRCPY_CROP = process.env.SCRCPY_CROP || '';
const APP_DISCOVERY_CACHE_MS = 60000;
const EXCLUDED_APP_PREFIXES = ['com.oculus.', 'com.meta.', 'com.android.', 'su.happ.'];
const EXCLUDED_APP_PACKAGES = new Set([
    'com.oculus.accountscenter',
    'com.oculus.igvr',
    'com.oculus.vrprivacycheckup',
    'com.meta.handseducationmodule',
    'su.happ.proxyutility',
    'com.whatsapp',
]);
const INCLUDED_NON_VR_PACKAGES = new Set([
    'com.bigscreenvr.bigscreen',
    'com.google.android.apps.youtube.vr.oculus',
    'com.activ8.kizunaaivr',
]);
const STREAM_FRAME_INTERVAL_MS = Number(process.env.STREAM_FRAME_INTERVAL_MS || 120);
const DEVICE_SERIAL_REGEX = /^[A-Za-z0-9._:-]+$/;
const STREAM_BOOT_TIMEOUT_MS = Number(process.env.STREAM_BOOT_TIMEOUT_MS || 7000);
const STREAM_MODE = process.env.STREAM_MODE || DEFAULT_CAST_TRANSPORT;
const STREAM_PROFILE = process.env.STREAM_PROFILE || DEFAULT_CAST_PROFILE;
const STREAM_DISPLAY_ID = process.env.STREAM_DISPLAY_ID || '';
const ICON_CACHE_ROOT = path.resolve(process.cwd(), '.cache', 'apk-icons');
const APK_CACHE_ROOT = path.join(ICON_CACHE_ROOT, 'apks');
const ICON_PUBLIC_ROOT = path.resolve(process.cwd(), 'public', 'app-icons');
const ICON_CACHE_INDEX_PATH = path.join(ICON_CACHE_ROOT, 'index.json');
const WIRELESS_STATE_PATH = path.resolve(process.cwd(), '.cache', 'local-hub', 'wireless-state.json');
const WIRELESS_CONNECT_RETRY_MS = Number(process.env.WIRELESS_CONNECT_RETRY_MS || 15000);
const WIRELESS_SETUP_RETRY_MS = Number(process.env.WIRELESS_SETUP_RETRY_MS || 60000);
const WIRELESS_ADB_PORT = Number(process.env.WIRELESS_ADB_PORT || 5555);
const HEARTBEAT_LOG_INTERVAL_MS = Number(process.env.HEARTBEAT_LOG_INTERVAL_MS || 15000);
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.BOOTSTRAP_TIMEOUT_MS || 5000);
const ADB_COMMAND_TIMEOUT_MS = Number(process.env.ADB_COMMAND_TIMEOUT_MS || 5000);
const AUTO_START_AGENT_RETRY_MS = Number(process.env.AUTO_START_AGENT_RETRY_MS || 20000);
const AGENT_PACKAGES = new Set(['com.bizonvr.spatialspike', QUEST_AGENT_PACKAGE]);

console.log(`Starting Local Hub (${HUB_ID}) connecting to ${API_URL}`);
console.log(`[Local Hub] Agent callback target: http://${HUB_HOST}:${LOCAL_SERVER_PORT}`);

process.on('uncaughtException', (error) => {
    console.error('[Local Hub] uncaughtException', {
        message: error?.message || String(error),
        stack: error?.stack || null,
        active_casts: Array.from(activeCastStreams.entries()).map(([route, stream]) => ({
            route,
            transport: stream.transport,
            profile: stream.profile,
            startedAt: stream.startedAt,
        })),
    });
});

process.on('unhandledRejection', (reason) => {
    console.error('[Local Hub] unhandledRejection', {
        reason: reason instanceof Error
            ? { message: reason.message, stack: reason.stack || null }
            : String(reason),
        active_casts: Array.from(activeCastStreams.entries()).map(([route, stream]) => ({
            route,
            transport: stream.transport,
            profile: stream.profile,
            startedAt: stream.startedAt,
        })),
    });
});

// Local Heartbeat Tracking
let agentHeartbeats = {};
const deviceAppCache = {};
const iconCacheIndex = loadIconCacheIndex();
const wirelessStateIndex = loadWirelessStateIndex();
let deviceRoutingIndex = {};
let lastHeartbeatLogAtByAgent = {};
let knownDevicesBootstrapped = false;
const autoStartInFlightByStableSerial = {};
const commandLocksByDevice = new Map();
const adbSupervisor = createAdbSupervisor({
    port: WIRELESS_ADB_PORT,
    log: (scope, message, extra) => logHub(scope, message, extra),
    getKnownState: (stableSerial) => wirelessStateIndex[stableSerial] || {},
    rememberRoute: (stableSerial, updates) => rememberWirelessRoute(stableSerial, updates),
    checkRoutePortOpen: (ip, port) => new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(1500);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, ip);
    }),
    adbDisconnect: async (serial) => {
        try {
            runAdbCapture(['disconnect', serial], { stdio: ['ignore', 'pipe', 'pipe'] });
            return { success: true };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    },
    adbConnect: async (serial) => {
        try {
            const message = runAdbCapture(['connect', serial], { stdio: ['ignore', 'pipe', 'pipe'] });
            const normalized = String(message).toLowerCase();
            const success = normalized.includes('connected to') || normalized.includes('already connected to');
            if (!success) {
                return { success: false, message: String(message).trim() || `ADB connect failed for ${serial}.` };
            }
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (isAdbRouteOnline(serial)) {
                    return { success: true, message: String(message).trim() };
                }
                sleepMs(250);
            }
            return { success: false, message: `Connected ${serial} but adb get-state did not stabilize.` };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    },
    verifyRouteIdentity: async ({ serial, expectedStableId, expectedAndroidId }) => {
        const stableId = getDeviceStableSerial(serial) || null;
        const androidId = getDeviceAndroidId(serial) || null;
        const matchedStableId = expectedStableId ? stableId === expectedStableId : true;
        const matchedAndroidId = expectedAndroidId ? androidId === expectedAndroidId : true;
        return {
            matched: matchedStableId && matchedAndroidId,
            stableId,
            androidId,
            message: `ADB route ${serial} resolved to stable_id=${stableId || 'unknown'} android_id=${androidId || 'unknown'}.`,
        };
    },
    checkAdbRecoveryPermission,
    tryEnableWirelessAdb,
});

// Keep track of running scrcpy processes
const scrcpyProcesses = {};
const activeCastStreams = new Map();
let screencapFallbackCount = 0;

// Regex for safe package name validation
const PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const bytes = fs.readFileSync(filePath);
    hash.update(bytes);
    return hash.digest('hex');
}

function logHub(scope, message, extra = null) {
    const prefix = `[${new Date().toISOString()}] [${scope}] ${message}`;
    if (extra === null || extra === undefined) {
        console.log(prefix);
        return;
    }
    console.log(prefix, extra);
}

function getPreferredHostIp() {
    const interfaces = os.networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
        for (const address of addresses || []) {
            if (address && address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return '127.0.0.1';
}

function isLoopbackHost(host) {
    return ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());
}

function resolveHubHost() {
    const explicitHost = process.env.HUB_HOST;
    if (explicitHost) {
        if (isLoopbackHost(explicitHost) && process.env.NODE_ENV === 'production') {
            throw new Error('HUB_HOST must be a real LAN IP for production Quest heartbeat, not 127.0.0.1/localhost.');
        }
        return explicitHost;
    }

    const detectedHost = getPreferredHostIp();
    if (isLoopbackHost(detectedHost)) {
        throw new Error('Could not auto-detect a LAN HUB_HOST. Set HUB_HOST to the Local Hub IP reachable from Quest, for example 192.168.x.x.');
    }
    return detectedHost;
}

function resolveQuestAgentApkPath() {
    const explicitPath = process.env.QUEST_AGENT_APK_PATH;
    if (explicitPath) {
        return path.resolve(explicitPath);
    }

    const candidates = [
        path.resolve(process.cwd(), 'quest-agent.apk'),
        path.resolve(process.cwd(), 'quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk'),
    ];

    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate);
            return candidate;
        } catch (e) {}
    }

    return candidates[0];
}

function buildAgentComponent() {
    const normalizedActivity = QUEST_AGENT_MAIN_ACTIVITY.startsWith('.')
        ? `${QUEST_AGENT_PACKAGE}/${QUEST_AGENT_MAIN_ACTIVITY}`
        : `${QUEST_AGENT_PACKAGE}/${QUEST_AGENT_MAIN_ACTIVITY}`;
    return normalizedActivity;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function loadIconCacheIndex() {
    try {
        return JSON.parse(fs.readFileSync(ICON_CACHE_INDEX_PATH, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveIconCacheIndex() {
    ensureDir(ICON_CACHE_ROOT);
    fs.writeFileSync(ICON_CACHE_INDEX_PATH, JSON.stringify(iconCacheIndex, null, 2));
}

function loadWirelessStateIndex() {
    try {
        return JSON.parse(fs.readFileSync(WIRELESS_STATE_PATH, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveWirelessStateIndex() {
    ensureDir(path.dirname(WIRELESS_STATE_PATH));
    fs.writeFileSync(WIRELESS_STATE_PATH, JSON.stringify(wirelessStateIndex, null, 2));
}

function clearIgnoredDevice(stableSerial) {
    if (!stableSerial || !wirelessStateIndex[stableSerial]?.ignored) {
        return;
    }

    const state = wirelessStateIndex[stableSerial] || {};
    wirelessStateIndex[stableSerial] = {
        ...state,
        ignored: false,
        ignoredAt: null,
        readyForRediscovery: false,
    };
    saveWirelessStateIndex();
}

function isIgnoredDevice(stableSerial, agentId = null) {
    const state = stableSerial ? wirelessStateIndex[stableSerial] : null;
    if (state?.ignored && !state?.readyForRediscovery) {
        return true;
    }
    if (!agentId) {
        return false;
    }
    return Object.values(wirelessStateIndex).some((entry) => entry?.ignored && entry?.agentId && entry.agentId === agentId);
}

function shouldKeepIgnoredDevice(stableSerial, transportId = null) {
    const state = stableSerial ? wirelessStateIndex[stableSerial] : null;
    if (!state?.ignored) {
        return false;
    }
    if (state.readyForRediscovery) {
        return false;
    }
    if (!state.ignoredTransportId) {
        return true;
    }
    return String(state.ignoredTransportId) === String(transportId || '');
}

function normalizeIpList(items) {
    return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pushPreviousIps(state, nextIp) {
    return normalizeIpList([nextIp, ...(state?.previousIps || []), state?.ip]).slice(0, 8);
}

function runAdbCapture(args, options = {}) {
    return execFileSync('adb', args, { encoding: 'utf-8', timeout: ADB_COMMAND_TIMEOUT_MS, ...options });
}

function runAdb(args, options = {}) {
    return execFileSync('adb', args, { timeout: ADB_COMMAND_TIMEOUT_MS, ...options });
}

function toWirelessSerial(ip) {
    return `${ip}:${WIRELESS_ADB_PORT}`;
}

function isTcpAdbSerial(value) {
    return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(String(value || '').trim());
}

function parseAdbDevices(output) {
    return output
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split(/\s+/).filter(Boolean);
            const meta = {};
            for (const token of parts.slice(2)) {
                const idx = token.indexOf(':');
                if (idx > 0) {
                    meta[token.slice(0, idx)] = token.slice(idx + 1);
                }
            }
            return {
                serial: parts[0],
                status: parts[1] || 'unknown',
                transportId: meta.transport_id || null,
                usbBus: meta.usb || null,
            };
        });
}

function listAdbDevicesDetailed() {
    try {
        return parseAdbDevices(runAdbCapture(['devices', '-l']));
    } catch (e) {
        console.warn('[WARN] ADB not found or errored. Using mock device "1G0YK01234" for testing.');
        return [{ serial: '1G0YK01234', status: 'device', transportId: null, usbBus: null }];
    }
}

function getDeviceWifiDetails(serial) {
    const details = { ip: null, wifiSsid: null };

    try {
        const out = runAdbCapture(['-s', serial, 'shell', 'ip', 'addr', 'show', 'wlan0']);
        const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) {
            details.ip = match[1];
        }
    } catch (e) {}

    try {
        const wifiStatus = runAdbCapture(['-s', serial, 'shell', 'cmd', 'wifi', 'status']);
        const ssidMatch = wifiStatus.match(/SSID:\s+"([^"]+)"/) || wifiStatus.match(/SSID:\s+([^\n,]+)/);
        if (ssidMatch) {
            details.wifiSsid = ssidMatch[1].trim().replace(/^"|"$/g, '');
        }
    } catch (e) {}

    return details;
}

function getDeviceStableSerial(serial) {
    try {
        const stableSerial = runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.serialno']).trim();
        return stableSerial || serial;
    } catch (e) {
        return serial;
    }
}

function getDeviceAndroidId(serial) {
    try {
        return runAdbCapture(['-s', serial, 'shell', 'settings', 'get', 'secure', 'android_id']).trim() || null;
    } catch (e) {
        return null;
    }
}

function getDeviceModel(serial) {
    try {
        return runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.product.model']).trim() || 'Meta Quest';
    } catch (e) {
        return 'Meta Quest';
    }
}

function mergeWirelessStateEntries(primaryKey, aliasKey) {
    if (!primaryKey || !aliasKey || primaryKey === aliasKey) {
        return primaryKey;
    }

    const primary = wirelessStateIndex[primaryKey] || {};
    const alias = wirelessStateIndex[aliasKey] || {};
    wirelessStateIndex[primaryKey] = {
        ...alias,
        ...primary,
        stableSerial: primaryKey,
        usbSerial: primary.usbSerial || alias.usbSerial || null,
        wirelessSerial: primary.wirelessSerial || alias.wirelessSerial || null,
        ip: primary.ip || alias.ip || null,
        wifiSsid: primary.wifiSsid || alias.wifiSsid || null,
        agentId: primary.agentId || alias.agentId || null,
        androidId: primary.androidId || alias.androidId || null,
        model: primary.model || alias.model || 'Meta Quest',
        previousIps: normalizeIpList([
            ...(primary.previousIps || []),
            ...(alias.previousIps || []),
            primary.ip || null,
            alias.ip || null,
        ]).slice(0, 8),
        lastSeenAt: Math.max(Number(primary.lastSeenAt || 0), Number(alias.lastSeenAt || 0), Date.now()),
    };
    delete wirelessStateIndex[aliasKey];
    saveWirelessStateIndex();
    return primaryKey;
}

function findCanonicalStableSerialForState(stableSerial, state) {
    if (!stableSerial || !state || !isTcpAdbSerial(stableSerial)) {
        return stableSerial;
    }
    if (state.usbSerial && !isTcpAdbSerial(state.usbSerial)) {
        return state.usbSerial;
    }
    const sibling = Object.entries(wirelessStateIndex).find(([key, entry]) =>
        key !== stableSerial &&
        !isTcpAdbSerial(key) &&
        (
            (entry?.wirelessSerial && state.wirelessSerial && entry.wirelessSerial === state.wirelessSerial) ||
            (entry?.ip && state.ip && entry.ip === state.ip) ||
            (entry?.agentId && state.agentId && entry.agentId === state.agentId)
        )
    );
    if (sibling) {
        return sibling[0];
    }
    if (state.wirelessSerial) {
        const liveStable = getDeviceStableSerial(state.wirelessSerial);
        if (liveStable && !isTcpAdbSerial(liveStable)) {
            return liveStable;
        }
    }
    return stableSerial;
}

function collapseWirelessStateAliases() {
    let changed = false;
    for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
        const canonicalStableSerial = findCanonicalStableSerialForState(stableSerial, state);
        if (canonicalStableSerial && canonicalStableSerial !== stableSerial) {
            mergeWirelessStateEntries(canonicalStableSerial, stableSerial);
            changed = true;
        }
    }
    if (changed) {
        saveWirelessStateIndex();
    }
}

function rememberWirelessRoute(stableSerial, updates) {
    const previousState = wirelessStateIndex[stableSerial] || {};
    const nextIp = updates.ip || previousState.ip || null;
    wirelessStateIndex[stableSerial] = {
        ...previousState,
        stableSerial,
        ...updates,
        previousIps: normalizeIpList([
            ...(updates.previousIps || []),
            ...pushPreviousIps(previousState, nextIp),
        ]).slice(0, 8),
        lastSeenAt: Date.now(),
    };
    saveWirelessStateIndex();
    collapseWirelessStateAliases();
}

function summarizeRouteHealth(route, cachedState = null) {
    const effectiveState = cachedState || wirelessStateIndex[route.stableSerial] || null;
    const supervisorState = adbSupervisor.getState(route.stableSerial) || null;
    const currentIp = route.ip || effectiveState?.ip || null;
    const cachedIp = effectiveState?.ip || null;
    const ipChanged = Boolean(route.ip && cachedIp && route.ip !== cachedIp);
    const hasWirelessRoute = Boolean(currentIp);
    const isConnectedOverWifi = Boolean(route.executionSerial && route.executionSerial.includes(':'));
    const usbAvailable = route.usbOnlineSnapshot === true;
    const agentOnline = Boolean(route.agentOnline);
    const agentKnown = Boolean(route.agentId || route.pairingId || effectiveState?.agentId);
    const unauthorized = route.adbState === 'unauthorized';
    const previousIps = normalizeIpList([currentIp, ...(effectiveState?.previousIps || [])]);
    const adbRecovery = supervisorState?.recovery || reportAdbRecoveryStatus();
    const degradedAdbStatus = supervisorState?.status === 'reconnecting'
        ? 'reconnecting'
        : supervisorState?.status === 'tcpip_unavailable'
            ? 'tcpip_unavailable'
            : supervisorState?.status === 'port_closed'
                ? 'port_closed'
                : supervisorState?.status === 'different_device'
                    ? 'different_device'
                : supervisorState?.status === 'unauthorized'
                    ? 'unauthorized'
                    : hasWirelessRoute
                        ? 'offline'
                        : 'unavailable';

    if (unauthorized) {
        return {
            adb_status: 'unauthorized',
            agent_status: agentOnline ? 'online' : 'offline',
            connection_status: 'usb_unauthorized',
            transport: 'usb',
            wifi_ready: false,
            usb_repair_required: true,
            status_reason: 'Quest is connected over USB, but ADB authorization is still waiting on the headset.',
            next_step: 'Put on the headset, allow USB debugging, then run pairing again.',
            wake_supported: false,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: ipChanged,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (isConnectedOverWifi && agentOnline) {
        return {
            adb_status: 'online',
            agent_status: 'online',
            connection_status: 'online',
            transport: 'wifi',
            wifi_ready: true,
            usb_repair_required: false,
            status_reason: ipChanged
                ? `Wi-Fi ADB reconnected. Device IP changed to ${route.ip}.`
                : 'Wi-Fi ADB is connected and ready for wake/session commands.',
            next_step: 'Quest is ready for sessions.',
            wake_supported: true,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: ipChanged,
            adb_recovery_status: 'ready',
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (isConnectedOverWifi) {
        return {
            adb_status: 'online',
            agent_status: agentKnown ? 'offline' : 'unknown',
            connection_status: 'wifi_ready',
            transport: 'wifi',
            wifi_ready: true,
            usb_repair_required: false,
            status_reason: 'Wi-Fi ADB is online, but Quest Agent heartbeat is missing.',
            next_step: 'Start or reinstall Quest Agent from the operator panel.',
            wake_supported: true,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: ipChanged,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (usbAvailable && hasWirelessRoute && agentOnline) {
        return {
            adb_status: 'online',
            agent_status: 'online',
            connection_status: 'pairing_in_progress',
            transport: 'usb',
            wifi_ready: false,
            usb_repair_required: false,
            status_reason: ipChanged
                ? `USB connected. Wi-Fi IP changed to ${route.ip}; Local Hub will refresh wireless routing.`
                : 'USB is connected. Local Hub can refresh the Wi-Fi ADB route for cable-free control.',
            next_step: 'Wait for wireless ADB to reconnect or run USB Repair once.',
            wake_supported: false,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: ipChanged,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (usbAvailable) {
        return {
            adb_status: 'online',
            agent_status: agentOnline ? 'online' : 'offline',
            connection_status: agentOnline ? 'pairing_in_progress' : 'adb_online_agent_offline',
            transport: 'usb',
            wifi_ready: false,
            usb_repair_required: false,
            status_reason: hasWirelessRoute
                ? 'USB is connected. Local Hub can refresh Wi-Fi ADB and verify Quest Agent.'
                : 'USB is connected. Finish first pairing to enable stable wireless recovery.',
            next_step: hasWirelessRoute
                ? 'Use USB Repair to refresh the wireless route and recheck Agent.'
                : 'Assign the headset to a room, install Quest Agent, then enable Wi-Fi ADB.',
            wake_supported: false,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: ipChanged,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (agentOnline) {
        return {
            adb_status: degradedAdbStatus,
            agent_status: 'online',
            connection_status: 'agent_online_adb_offline',
            transport: 'agent_only',
            wifi_ready: false,
            usb_repair_required: hasWirelessRoute,
            status_reason: supervisorState?.lastError
                ? `Quest Agent heartbeat is arriving, but ADB recovery is blocked: ${supervisorState.lastError}`
                : 'Quest Agent heartbeat is arriving, but ADB is offline.',
            next_step: degradedAdbStatus === 'reconnecting'
                ? 'Local Hub is retrying saved Wi-Fi routes with backoff. Leave the headset on club Wi-Fi.'
                : degradedAdbStatus === 'different_device'
                    ? 'ADB connected to a different Quest on the remembered route. Reconnect USB once to refresh the trusted identity.'
                : degradedAdbStatus === 'tcpip_unavailable'
                    ? 'Wireless debugging is not answering on port 5555. Use USB Repair or future secure-settings recovery.'
                    : degradedAdbStatus === 'port_closed'
                        ? 'The remembered Quest IP is reachable, but port 5555 is closed. Re-enable wireless ADB with USB Repair.'
                        : 'Use USB Repair to restore Wi-Fi ADB without creating the headset again.',
            wake_supported: false,
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: false,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    if (hasWirelessRoute) {
        return {
            adb_status: degradedAdbStatus,
            agent_status: agentKnown ? 'offline' : 'unknown',
            connection_status: effectiveState?.hadSuccessfulWifiConnection ? 'vpn_or_lan_blocked' : 'offline_sleeping',
            transport: 'disconnected',
            wifi_ready: false,
            usb_repair_required: Boolean(effectiveState?.hadSuccessfulWifiConnection),
            status_reason: supervisorState?.lastError
                ? supervisorState.lastError
                : effectiveState?.hadSuccessfulWifiConnection
                    ? `Quest is known, but the saved Wi-Fi ADB route ${currentIp}:${WIRELESS_ADB_PORT} is unreachable.`
                    : `Remembered Wi-Fi route ${currentIp}:${WIRELESS_ADB_PORT} is saved. Local Hub is still trying to reconnect.`,
            next_step: degradedAdbStatus === 'reconnecting'
                ? 'Local Hub is retrying last known IPs and heartbeat routes.'
                : degradedAdbStatus === 'different_device'
                    ? 'The remembered Wi-Fi route points at another device. Reconnect USB and refresh the wireless route.'
                : effectiveState?.hadSuccessfulWifiConnection
                    ? 'Possible causes: VPN blocks the LAN, IP changed, or wireless debugging was reset. Connect USB and run USB Repair.'
                    : 'Leave the headset awake on club Wi-Fi or reconnect USB once to finish setup.',
            wake_supported: Boolean(!effectiveState?.hadSuccessfulWifiConnection),
            wifi_ip: currentIp,
            previous_ips: previousIps,
            ip_changed: false,
            adb_recovery_status: adbRecovery.status,
            adb_recovery_permission: adbRecovery.permission,
        };
    }

    return {
        adb_status: 'unavailable',
        agent_status: 'unknown',
        connection_status: route.knownDevice ? 'usb_pairing_required' : 'new',
        transport: 'disconnected',
        wifi_ready: false,
        usb_repair_required: true,
        status_reason: route.knownDevice
            ? 'Quest identity is known, but there is no active USB or Wi-Fi ADB route.'
            : 'Wireless ADB is not configured yet. Connect this Quest over trusted USB first.',
        next_step: route.knownDevice
            ? 'Connect the headset over USB and run USB Repair. Do not add it again.'
            : 'Connect the headset over USB to start first pairing.',
        wake_supported: false,
        wifi_ip: null,
        previous_ips: previousIps,
        ip_changed: false,
        adb_recovery_status: adbRecovery.status,
        adb_recovery_permission: adbRecovery.permission,
    };
}

function isAgentPackageInstalled(deviceSerial) {
    try {
        const output = runAdbCapture(['-s', deviceSerial, 'shell', 'pm', 'path', QUEST_AGENT_PACKAGE]);
        return output.includes(`package:`) && output.includes(QUEST_AGENT_PACKAGE);
    } catch (e) {
        return false;
    }
}

function maybeAutoStartAgent(route, routeHealth) {
    const stableSerial = route?.stableSerial;
    if (!stableSerial || autoStartInFlightByStableSerial[stableSerial]) {
        return;
    }

    const shouldRecoverAgent = ['wifi_ready', 'adb_online_agent_offline'].includes(routeHealth?.connection_status);
    const knownDevice = Boolean(route?.agentId || route?.pairingId || route?.knownDevice || wirelessStateIndex[stableSerial]?.knownDevice);
    if (!shouldRecoverAgent || !knownDevice) {
        return;
    }

    const state = wirelessStateIndex[stableSerial] || {};
    const lastAttemptAt = Number(state.lastAutoStartAttemptAt || 0);
    if ((Date.now() - lastAttemptAt) < AUTO_START_AGENT_RETRY_MS) {
        return;
    }

    const executionSerial = resolveExecutionSerial(stableSerial) || route?.executionSerial || route?.wirelessSerial || route?.usbSerial;
    if (!executionSerial) {
        return;
    }

    rememberWirelessRoute(stableSerial, { lastAutoStartAttemptAt: Date.now() });
    if (!isAgentPackageInstalled(executionSerial)) {
        logHub('Agent', `Auto-start skipped for ${stableSerial}: ${QUEST_AGENT_PACKAGE} is not installed on ${executionSerial}`);
        return;
    }

    autoStartInFlightByStableSerial[stableSerial] = true;
    logHub('Agent', `Auto-starting Quest Agent for ${stableSerial} via ${executionSerial}`);
    spawnAdb(buildAgentStartArgs(executionSerial), 'Quest Agent auto-started')
        .then((result) => {
            if (result.success) {
                logHub('Agent', `Quest Agent auto-started for ${stableSerial}`);
            } else {
                logHub('Agent', `Quest Agent auto-start failed for ${stableSerial}`, result.error || result);
            }
        })
        .finally(() => {
            delete autoStartInFlightByStableSerial[stableSerial];
        });
}

function findStableSerialByWirelessIp(ip) {
    const entries = Object.entries(wirelessStateIndex).sort(([left], [right]) => {
        const leftTcp = isTcpAdbSerial(left);
        const rightTcp = isTcpAdbSerial(right);
        if (leftTcp === rightTcp) return 0;
        return leftTcp ? 1 : -1;
    });
    for (const [stableSerial, state] of entries) {
        if (state?.ip === ip || state?.wirelessSerial === toWirelessSerial(ip)) {
            return stableSerial;
        }
    }
    return null;
}

function connectWirelessTarget(stableSerial, force = false) {
    const state = wirelessStateIndex[stableSerial];
    if (state?.ignored) {
        return false;
    }
    const candidateIps = normalizeIpList([state?.ip, ...(state?.previousIps || [])]);
    if (candidateIps.length === 0) {
        return false;
    }

    const lastAttemptAt = Number(state.lastConnectAttemptAt || 0);
    if (!force && (Date.now() - lastAttemptAt) < WIRELESS_CONNECT_RETRY_MS) {
        return false;
    }

    rememberWirelessRoute(stableSerial, { lastConnectAttemptAt: Date.now() });

    for (const ip of candidateIps) {
        const wirelessSerial = toWirelessSerial(ip);
        try {
            if (force) {
                const staleRoutes = normalizeIpList([wirelessSerial, state?.wirelessSerial]);
                for (const staleRoute of staleRoutes) {
                    try {
                        runAdbCapture(['disconnect', staleRoute], { stdio: ['ignore', 'pipe', 'pipe'] });
                    } catch (disconnectError) {
                        logHub('Wireless ADB', `Disconnect before forced reconnect failed for ${staleRoute}`, {
                            stableSerial,
                            error: disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
                        });
                    }
                }
                sleepMs(250);
            }
            for (let connectAttempt = 0; connectAttempt < (force ? 2 : 1); connectAttempt += 1) {
                const output = runAdbCapture(['connect', wirelessSerial], { stdio: ['ignore', 'pipe', 'pipe'] });
                const normalized = output.toLowerCase();
                const connected = normalized.includes('connected to') || normalized.includes('already connected to');
                if (connected) {
                    let verified = false;
                    for (let attempt = 0; attempt < 6; attempt += 1) {
                        if (isAdbRouteOnline(wirelessSerial)) {
                            verified = true;
                            break;
                        }
                        sleepMs(250);
                    }
                    if (!verified) {
                        console.warn(`[Wireless ADB] Connected ${wirelessSerial} but adb get-state is not stable yet`);
                        if (force && connectAttempt === 0) {
                            try {
                                runAdbCapture(['disconnect', wirelessSerial], { stdio: ['ignore', 'pipe', 'pipe'] });
                            } catch (disconnectError) {
                                logHub('Wireless ADB', `Disconnect after unstable forced connect failed for ${wirelessSerial}`, {
                                    stableSerial,
                                    error: disconnectError instanceof Error ? disconnectError.message : String(disconnectError),
                                });
                            }
                            sleepMs(300);
                            continue;
                        }
                        break;
                    }
                    logHub('Wireless ADB', `Connected ${wirelessSerial} for ${stableSerial}`);
                    rememberWirelessRoute(stableSerial, {
                        ip,
                        wirelessSerial,
                        hadSuccessfulWifiConnection: true,
                        lastVerifiedWirelessAt: Date.now(),
                    });
                    return true;
                }
                console.warn(`[Wireless ADB] Connect did not succeed for ${wirelessSerial}: ${output.trim()}`);
            }
        } catch (e) {
            console.warn(`[Wireless ADB] Failed to connect ${wirelessSerial}: ${e.message}`);
        }
    }

    return false;
}

function isAdbRouteOnline(serial) {
    if (!serial) {
        return false;
    }
    try {
        return runAdbCapture(['-s', serial, 'get-state'], { stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'device';
    } catch (e) {
        return false;
    }
}

function getRouteOnlineState(route, cache = new Map()) {
    const readOnline = (serial) => {
        if (!serial) {
            return false;
        }
        if (!cache.has(serial)) {
            cache.set(serial, isAdbRouteOnline(serial));
        }
        return Boolean(cache.get(serial));
    };

    return {
        usbOnline: route.usbOnlineSnapshot === true ? true : readOnline(route.usbSerial),
        wirelessOnline: route.wirelessOnlineSnapshot === true ? true : readOnline(route.wirelessSerial) || (
            Boolean(route.wirelessSerial) &&
            Number(route.lastVerifiedWirelessAt || 0) > 0 &&
            (Date.now() - Number(route.lastVerifiedWirelessAt || 0)) < 5000
        ),
    };
}

function chooseExecutionRoute(route, purpose = 'control', cache = new Map()) {
    const onlineState = getRouteOnlineState(route, cache);
    return selectPreferredExecutionRoute({
        usbSerial: route.usbSerial || null,
        wirelessSerial: route.wirelessSerial || null,
        usbOnline: onlineState.usbOnline,
        wirelessOnline: onlineState.wirelessOnline,
    }, { purpose });
}

function formatAppName(pkg) {
    const knownNames = {
        'com.bigscreenvr.bigscreen': 'Bigscreen',
        'com.google.android.apps.youtube.vr.oculus': 'YouTube VR',
        'com.activ8.kizunaaivr': 'Kizuna AI VR',
        'com.meta.handseducationmodule': 'Hands Education Module',
        'com.bizonvr.spatialspike': 'Quest Agent spatial',
    };

    if (knownNames[pkg]) return knownNames[pkg];

    const base = pkg.split('.').pop() || pkg;
    return base
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function sanitizePackageForFilename(pkg) {
    return pkg.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parsePackages(output) {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^package:/, ''))
        .filter(Boolean);
}

function parseActivityComponents(output) {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.includes('activities found:') && line.includes('/'));
}

function scoreLaunchComponent(component) {
    const normalized = component.toLowerCase();
    let score = 0;

    if (normalized.includes('internal')) score -= 50;
    if (normalized.includes('panel')) score -= 15;
    if (normalized.includes('launcher')) score += 20;
    if (normalized.includes('mainactivity')) score += 15;
    if (normalized.includes('unityplayeractivity')) score += 12;
    if (normalized.endsWith('/.mainactivity')) score += 10;
    if (normalized.includes('youtubevractivity')) score += 8;
    if (normalized.includes('vr')) score += 4;

    return score;
}

function chooseBestLaunchComponent(components) {
    if (!Array.isArray(components) || components.length === 0) {
        return null;
    }

    return [...components]
        .sort((a, b) => scoreLaunchComponent(b) - scoreLaunchComponent(a))[0] || null;
}

function chooseBestIconEntry(entries) {
    const iconEntries = entries.filter((entry) => /\.(png|webp)$/i.test(entry));
    if (iconEntries.length === 0) return null;

    const densityScore = (entry) => {
        if (entry.includes('xxxhdpi')) return 6;
        if (entry.includes('xxhdpi')) return 5;
        if (entry.includes('xhdpi')) return 4;
        if (entry.includes('hdpi')) return 3;
        if (entry.includes('mdpi')) return 2;
        if (entry.includes('ldpi')) return 1;
        return 0;
    };

    const ranked = iconEntries
        .map((entry) => {
            let score = 0;
            if (/res\/mipmap.*\/app_icon\.(png|webp)$/i.test(entry)) score += 120;
            else if (/res\/mipmap.*\/ic_launcher.*\.(png|webp)$/i.test(entry)) score += 110;
            else if (/res\/drawable.*\/app_icon\.(png|webp)$/i.test(entry)) score += 100;
            else if (/res\/drawable.*\/ic_launcher.*\.(png|webp)$/i.test(entry)) score += 90;
            else if (/assets\/.*(launcher|app_icon|icon|logo).*\.(png|webp)$/i.test(entry)) score += 60;

            if (/foreground/i.test(entry)) score -= 30;
            if (/background/i.test(entry)) score -= 40;
            if (/round/i.test(entry)) score -= 5;
            score += densityScore(entry);

            return { entry, score };
        })
        .sort((a, b) => b.score - a.score);

    return ranked[0]?.score > 0 ? ranked[0].entry : null;
}

function ensureAppIcon(serial, pkg) {
    if (!isValidPackage(pkg)) {
        return null;
    }

    try {
        const cached = iconCacheIndex[pkg];
        if (cached?.fileName) {
            const existingIconPath = path.join(ICON_PUBLIC_ROOT, cached.fileName);
            if (fs.existsSync(existingIconPath)) {
                return `/app-icons/${cached.fileName}`;
            }
        }
        // Do not pull and unzip APKs during hub polling. That work blocks the
        // event loop and can starve heartbeats/session commands. Cached icons
        // remain available; uncached apps simply render without icons.
        return null;
    } catch (e) {
        console.warn(`[WARN] Icon extraction failed for ${pkg}: ${e.message}`);
        return null;
    }
}

function shouldIncludeLaunchableApp(app) {
    if (EXCLUDED_APP_PACKAGES.has(app.package)) {
        return false;
    }

    if (INCLUDED_NON_VR_PACKAGES.has(app.package)) {
        return true;
    }

    if (EXCLUDED_APP_PREFIXES.some((prefix) => app.package.startsWith(prefix))) {
        return false;
    }

    if (app.sources.has('vr')) {
        return true;
    }

    if (app.sources.has('package')) {
        return true;
    }

    return app.activity.includes('com.unity3d.player.UnityPlayerActivity');
}

function resolveLaunchComponentDirect(deviceSerial, packageName) {
    if (!packageName) {
        return null;
    }

    const queries = [
        ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', packageName],
        ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.INFO', packageName],
        ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName],
        ['-s', deviceSerial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', packageName],
    ];

    for (const args of queries) {
        try {
            const output = runAdbCapture(args).trim();
            const component = output
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.includes('/'));
            const selected = chooseBestLaunchComponent(component);
            if (selected) {
                return selected;
            }
        } catch (e) {}
    }

    return null;
}

function getLaunchableApps(serial) {
    const cached = deviceAppCache[serial];
    if (cached && (Date.now() - cached.timestamp) < APP_DISCOVERY_CACHE_MS) {
        return cached.apps;
    }

    try {
        const thirdPartyPackages = new Set(parsePackages(runAdbCapture(
            ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages', '-3'],
        )));

        const activityQueries = [
            { source: 'launcher', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '--brief'] },
            { source: 'info', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.INFO', '--brief'] },
            { source: 'vr', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', '--brief'] },
        ];

        const launchableApps = new Map();
        for (const query of activityQueries) {
            const output = runAdbCapture(query.args);
            for (const component of parseActivityComponents(output)) {
                const pkg = component.split('/')[0];
                if (thirdPartyPackages.has(pkg) && !AGENT_PACKAGES.has(pkg)) {
                    const existing = launchableApps.get(pkg);
                    if (existing) {
                        existing.sources.add(query.source);
                        existing.activities.push(component);
                        existing.activity = chooseBestLaunchComponent(existing.activities) || existing.activity;
                    } else {
                        launchableApps.set(pkg, {
                            package: pkg,
                            name: formatAppName(pkg),
                            activity: component,
                            activities: [component],
                            sources: new Set([query.source]),
                        });
                    }
                }
            }
        }

        for (const pkg of thirdPartyPackages) {
            if (AGENT_PACKAGES.has(pkg) || launchableApps.has(pkg)) {
                continue;
            }

            const component = resolveLaunchComponentDirect(serial, pkg);
            if (!component) {
                continue;
            }

            launchableApps.set(pkg, {
                package: pkg,
                name: formatAppName(pkg),
                activity: component,
                activities: [component],
                sources: new Set(['package']),
            });
        }

        const apps = [...launchableApps.values()]
            .filter(shouldIncludeLaunchableApp)
            .map(({ sources, activities, ...app }) => ({
                ...app,
                icon_url: ensureAppIcon(serial, app.package),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        deviceAppCache[serial] = {
            apps,
            timestamp: Date.now(),
        };

        return apps;
    } catch (e) {
        console.warn(`[WARN] App discovery failed for ${serial}: ${e.message}`);
        return cached?.apps || [];
    }
}

function setupWirelessAdb(serial, wifiDetails, options = {}) {
    if (!ENABLE_WIRELESS_ADB || !wifiDetails?.ip) {
        return;
    }

    const state = wirelessStateIndex[serial] || {};
    const lastSetupAt = Number(state.lastSetupAttemptAt || 0);
    if (!options.force && (Date.now() - lastSetupAt) < WIRELESS_SETUP_RETRY_MS) {
        return;
    }

    rememberWirelessRoute(serial, {
        usbSerial: serial,
        ip: wifiDetails.ip,
        wifiSsid: wifiDetails.wifiSsid ?? null,
        wirelessSerial: toWirelessSerial(wifiDetails.ip),
        lastSetupAttemptAt: Date.now(),
    });

    console.log(`[Wireless ADB] Enabling TCP/IP for ${serial} on ${wifiDetails.ip}:${WIRELESS_ADB_PORT}...`);
    try {
        runAdbCapture(['-s', serial, 'tcpip', String(WIRELESS_ADB_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        console.warn(`[Wireless ADB] tcpip setup failed for ${serial}: ${e.message}`);
        return;
    }

    connectWirelessTarget(serial, true);
}

function refreshDeviceRouting(allowWirelessSetup = true) {
    collapseWirelessStateAliases();
    const adbDevices = listAdbDevicesDetailed().filter((entry) => ['device', 'unauthorized'].includes(entry.status));
    const justConnectedRoutes = [];
    const routes = new Map();
    const seenStableSerials = new Set();
    const wirelessByIp = new Map(
        adbDevices
            .filter((entry) => entry.serial.includes(':') && entry.status === 'device')
            .map((entry) => [entry.serial.split(':')[0], entry.serial]),
    );

    for (const entry of adbDevices) {
        const serial = entry.serial;
        if (serial.includes(':') || serial.startsWith('emulator-')) {
            continue;
        }

        const stableSerial = entry.status === 'device' ? getDeviceStableSerial(serial) : serial;
        seenStableSerials.add(stableSerial);
        const wifiDetails = entry.status === 'device' ? getDeviceWifiDetails(serial) : { ip: null, wifiSsid: null };
        const state = wirelessStateIndex[stableSerial] || {};
        if (shouldKeepIgnoredDevice(stableSerial, entry.transportId)) {
            continue;
        }
        if (state.ignored) {
            clearIgnoredDevice(stableSerial);
        }
        const route = {
            stableSerial,
            executionSerial: entry.status === 'device' ? serial : null,
            usbSerial: serial,
            usbOnlineSnapshot: entry.status === 'device',
            wirelessOnlineSnapshot: false,
            wirelessSerial: state.wirelessSerial || (state.ip ? toWirelessSerial(state.ip) : null),
            ip: wifiDetails.ip || state.ip || null,
            wifiSsid: wifiDetails.wifiSsid || state.wifiSsid || null,
            lastVerifiedWirelessAt: Number(state.lastVerifiedWirelessAt || 0),
            adbState: entry.status === 'unauthorized' ? 'unauthorized' : 'online',
            transportId: entry.transportId || null,
            androidId: entry.status === 'device' ? getDeviceAndroidId(serial) : state.androidId || null,
            model: entry.status === 'device' ? getDeviceModel(serial) : state.model || 'Meta Quest',
            agentId: state.agentId || null,
            pairingId: state.agentId || null,
            knownDevice: Boolean(state.knownDevice || state.agentId || state.ip || state.previousIps?.length),
        };

        if (wifiDetails.ip) {
            const wirelessSerial = wirelessByIp.get(wifiDetails.ip) || toWirelessSerial(wifiDetails.ip);
            route.wirelessSerial = wirelessSerial;
            rememberWirelessRoute(stableSerial, {
                usbSerial: serial,
                ip: wifiDetails.ip,
                wifiSsid: wifiDetails.wifiSsid ?? null,
                wirelessSerial,
                androidId: route.androidId,
                model: route.model,
            });

            if (wirelessByIp.has(wifiDetails.ip)) {
                route.executionSerial = wirelessSerial;
            } else if (allowWirelessSetup) {
                setupWirelessAdb(serial, wifiDetails);
            }
        } else if (route.wirelessSerial && isAdbRouteOnline(route.wirelessSerial)) {
            route.executionSerial = route.wirelessSerial;
        }

        routes.set(stableSerial, route);
    }

    for (const entry of adbDevices.filter((item) => item.serial.includes(':') && item.status === 'device')) {
        const ip = entry.serial.split(':')[0];
        const routeMatchedByIp = [...routes.values()].find((route) => route.ip === ip);
        const liveStableSerial = getDeviceStableSerial(entry.serial);
        const resolvedStableSerial =
            routeMatchedByIp?.stableSerial ||
            (liveStableSerial && !isTcpAdbSerial(liveStableSerial) ? liveStableSerial : null) ||
            findStableSerialByWirelessIp(ip) ||
            liveStableSerial;
        seenStableSerials.add(resolvedStableSerial);
        if (isIgnoredDevice(resolvedStableSerial)) {
            continue;
        }
        const existing = routes.get(resolvedStableSerial);
        if (existing) {
            existing.wirelessSerial = entry.serial;
            existing.executionSerial = entry.serial;
            existing.wirelessOnlineSnapshot = true;
            existing.ip = existing.ip || ip;
            existing.adbState = 'online';
            existing.transportId = entry.transportId || existing.transportId || null;
        } else {
            const state = wirelessStateIndex[resolvedStableSerial] || {};
            routes.set(resolvedStableSerial, {
                stableSerial: resolvedStableSerial,
                executionSerial: entry.serial,
                usbSerial: state.usbSerial || null,
                usbOnlineSnapshot: false,
                wirelessOnlineSnapshot: true,
                wirelessSerial: entry.serial,
                ip,
                wifiSsid: state.wifiSsid || null,
                adbState: 'online',
                transportId: entry.transportId || null,
                androidId: state.androidId || null,
                model: state.model || 'Meta Quest',
                agentId: state.agentId || null,
                pairingId: state.agentId || null,
                knownDevice: true,
            });
        }

        rememberWirelessRoute(resolvedStableSerial, {
            ip,
            wirelessSerial: entry.serial,
            usbSerial: existing?.usbSerial || wirelessStateIndex[resolvedStableSerial]?.usbSerial || null,
            androidId: getDeviceAndroidId(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.androidId || null,
            model: getDeviceModel(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.model || 'Meta Quest',
            hadSuccessfulWifiConnection: true,
        });
    }

    if (ENABLE_WIRELESS_ADB) {
        for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
            if (!state?.ip || state?.ignored || routes.has(stableSerial)) {
                continue;
            }
            if (connectWirelessTarget(stableSerial, false)) {
                justConnectedRoutes.push({
                    stableSerial,
                    ip: state.ip,
                    wirelessSerial: state.wirelessSerial || toWirelessSerial(state.ip),
                });
            }
        }
    }

    for (const route of justConnectedRoutes) {
        routes.set(route.stableSerial, {
            stableSerial: route.stableSerial,
            executionSerial: route.wirelessSerial,
            usbSerial: wirelessStateIndex[route.stableSerial]?.usbSerial || null,
            usbOnlineSnapshot: false,
            wirelessOnlineSnapshot: true,
            wirelessSerial: route.wirelessSerial,
            ip: route.ip,
            wifiSsid: wirelessStateIndex[route.stableSerial]?.wifiSsid || null,
            adbState: 'online',
            androidId: wirelessStateIndex[route.stableSerial]?.androidId || null,
            model: wirelessStateIndex[route.stableSerial]?.model || 'Meta Quest',
            agentId: wirelessStateIndex[route.stableSerial]?.agentId || null,
            pairingId: wirelessStateIndex[route.stableSerial]?.agentId || null,
            knownDevice: true,
        });
    }

    for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
        if (state?.ignored || routes.has(stableSerial)) {
            continue;
        }

        routes.set(stableSerial, {
            stableSerial,
            executionSerial: null,
            usbSerial: state.usbSerial || null,
            usbOnlineSnapshot: false,
            wirelessOnlineSnapshot: false,
            wirelessSerial: state.wirelessSerial || toWirelessSerial(state.ip),
            ip: state.ip || null,
            wifiSsid: state.wifiSsid || null,
            adbState: 'offline',
            androidId: state.androidId || null,
            model: state.model || 'Meta Quest',
            agentId: state.agentId || null,
            pairingId: state.agentId || null,
            knownDevice: true,
        });
    }

    for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
        if (!state?.ignored) {
            continue;
        }
        if (!seenStableSerials.has(stableSerial) && !state.readyForRediscovery) {
            wirelessStateIndex[stableSerial] = {
                ...state,
                readyForRediscovery: true,
            };
            saveWirelessStateIndex();
        }
    }

    const onlineStateCache = new Map();
    for (const route of routes.values()) {
        route.executionSerial = chooseExecutionRoute(route, 'control', onlineStateCache);
    }

    deviceRoutingIndex = Object.fromEntries(routes.entries());
    for (const route of Object.values(deviceRoutingIndex)) {
        void adbSupervisor.tick(route, { route });
    }
    logHub('Routing', 'Resolved device routes', Object.values(deviceRoutingIndex).map((route) => ({
        stableSerial: route.stableSerial,
        executionSerial: route.executionSerial,
        usbSerial: route.usbSerial,
        wirelessSerial: route.wirelessSerial,
        ip: route.ip,
    })));
    return Object.values(deviceRoutingIndex);
}

function resolveExecutionSerial(stableSerial) {
    const route = deviceRoutingIndex[stableSerial];
    if (route?.executionSerial && isAdbRouteOnline(route.executionSerial)) {
        return route.executionSerial;
    }

    refreshDeviceRouting(false);
    const refreshedRoute = deviceRoutingIndex[stableSerial];
    if (refreshedRoute?.executionSerial && isAdbRouteOnline(refreshedRoute.executionSerial)) {
        return refreshedRoute.executionSerial;
    }

    if (wirelessStateIndex[stableSerial]?.ip && connectWirelessTarget(stableSerial, true)) {
        refreshDeviceRouting(false);
        const reconnectedRoute = deviceRoutingIndex[stableSerial];
        if (reconnectedRoute?.executionSerial && isAdbRouteOnline(reconnectedRoute.executionSerial)) {
            return reconnectedRoute.executionSerial;
        }
    }

    return null;
}

function resolveStableSerial(routeKey) {
    if (deviceRoutingIndex[routeKey]) {
        return routeKey;
    }

    const matched = Object.values(deviceRoutingIndex).find((route) =>
        route.executionSerial === routeKey || route.wirelessSerial === routeKey || route.usbSerial === routeKey
    );
    return matched?.stableSerial || routeKey;
}

function resolveRouteForCommand(routeKey, commandType, payload = {}) {
    const stableSerial = resolveStableSerial(routeKey);
    const route = deviceRoutingIndex[stableSerial];
    const purpose = prefersUsbForCommand(commandType, payload) ? 'maintenance' : 'control';
    const selectedRoute = route ? chooseExecutionRoute(route, purpose) : null;
    return {
        stableSerial,
        selectedRoute: selectedRoute || (purpose === 'control' ? resolveExecutionSerial(stableSerial) : null),
    };
}

function isValidPackage(pkg) {
    return pkg && PACKAGE_NAME_REGEX.test(pkg);
}

function isValidDeviceSerial(serial) {
    return serial && DEVICE_SERIAL_REGEX.test(serial);
}

function wakeDeviceForCast(deviceSerial) {
    wakeDevice(deviceSerial).catch((e) => {
        console.warn(`[Local Hub] Could not wake device before cast: ${e.message}`);
    });
}

function getScreenrecordDisplayArgs(deviceSerial) {
    if (STREAM_DISPLAY_ID) {
        return ['--display-id', STREAM_DISPLAY_ID];
    }

    try {
        const output = runAdbCapture(['-s', deviceSerial, 'shell', 'dumpsys', 'SurfaceFlinger', '--display-id']);
        const match = output.match(/Display\s+(\d+)\s+\(HWC display 0\)/);
        return match ? ['--display-id', match[1]] : [];
    } catch (e) {
        console.warn(`[Local Hub] Could not detect display id for screenrecord: ${e.message}`);
        return [];
    }
}

// Safely execute ADB
function getAdbDevices() {
    return refreshDeviceRouting(true)
        .filter((route) => Boolean(route.executionSerial) || route.adbState === 'unauthorized')
        .map((route) => route.stableSerial);
}

function spawnAdb(args, onSuccessMessage) {
    return new Promise((resolve) => {
        const proc = spawn('adb', args);
        let errorOutput = '';
        proc.stderr.on('data', data => errorOutput += data.toString());
        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, message: onSuccessMessage || "Command executed successfully" });
            } else {
                resolve({ success: false, error: errorOutput || `Process exited with code ${code}` });
            }
        });
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
    });
}

function capturePngFrame(deviceSerial) {
    return new Promise((resolve) => {
        if (!isValidDeviceSerial(deviceSerial)) {
            return resolve({ success: false, error: 'Invalid device serial' });
        }

        const proc = spawn('adb', ['-s', deviceSerial, 'exec-out', 'screencap', '-p']);
        const chunks = [];
        let errorOutput = '';

        proc.stdout.on('data', (chunk) => chunks.push(chunk));
        proc.stderr.on('data', (chunk) => {
            errorOutput += chunk.toString();
        });
        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, frame: Buffer.concat(chunks) });
            } else {
                resolve({ success: false, error: errorOutput || `screencap exited with code ${code}` });
            }
        });
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
    });
}

function streamDeviceFramesFallback(req, res, deviceSerial, options = {}) {
    const startedAt = Date.now();
    const boundary = options.boundary || 'frame';
    const sourceLabel = options.sourceLabel || 'screencap';
    let closed = false;
    let frameCount = 0;
    let totalBytes = 0;
    let firstFrameAt = null;

    const stopStream = () => {
        closed = true;
    };

    req.on('close', stopStream);
    req.on('aborted', stopStream);

    if (!res.headersSent) {
        const wroteHeaders = safeWriteHead(res, 200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            Connection: 'close',
            'X-BizonVR-Cast-Transport': 'screencap',
        });

        if (!wroteHeaders) {
            logHub('Cast', `Fallback could not start response for ${deviceSerial}`, {
                source: sourceLabel,
                reason: 'response_not_writable',
            });
            return safeEnd(res);
        }
    }

    const sendFrame = async () => {
        if (closed || !isResponseWritable(res)) {
            return;
        }

        const result = await capturePngFrame(deviceSerial);
        if (!result.success) {
            if (!closed && isResponseWritable(res)) {
                safeWrite(res, `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({
                    error: 'STREAM_CAPTURE_FAILED',
                    message: result.error,
                })}\r\n`);
            }
            stopStream();
            return safeEnd(res);
        }

        const frame = result.frame;
        frameCount += 1;
        totalBytes += frame.length;
        if (!firstFrameAt) {
            firstFrameAt = Date.now();
            logHub('Cast', `First fallback frame for ${deviceSerial} after ${firstFrameAt - startedAt}ms`, {
                source: 'screencap',
                frame_bytes: frame.length,
            });
        }

        if (!safeWrite(res, `--${boundary}\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`)) {
            stopStream();
            return;
        }
        if (!safeWrite(res, frame)) {
            stopStream();
            return;
        }
        if (!safeWrite(res, '\r\n')) {
            stopStream();
            return;
        }

        setTimeout(sendFrame, STREAM_FRAME_INTERVAL_MS);
    };

    res.on('close', () => {
        const elapsedMs = Math.max(Date.now() - startedAt, 1);
        logHub('Cast', `Fallback stream closed for ${deviceSerial}`, {
            source: sourceLabel,
            frames: frameCount,
            avg_frame_bytes: frameCount ? Math.round(totalBytes / frameCount) : 0,
            throughput_kbps: Math.round((totalBytes * 8) / elapsedMs),
        });
    });

    sendFrame();
}

function streamDeviceFrames(req, res, deviceSerial, requestedTransport = STREAM_MODE, requestedProfile = STREAM_PROFILE) {
    const streamRequest = resolveStreamRequest(requestedTransport, requestedProfile);
    if (!streamRequest.ok) {
        safeWriteHead(res, streamRequest.status, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify(streamRequest.body));
    }

    const streamMode = streamRequest.transport;
    const profile = getStreamProfile(streamRequest.profileKey);
    const executionSerial = resolveExecutionSerial(deviceSerial) || deviceSerial;
    const activeStream = activeCastStreams.get(executionSerial);

    if (activeStream) {
        safeWriteHead(res, 409, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify({
            error: 'CAST_ALREADY_ACTIVE',
            message: `A cast is already running for ${executionSerial}`,
            active_transport: activeStream.transport,
            active_profile: activeStream.profile,
            next_step: 'Close the existing cast tab or wait for Local Hub to release the stream, then retry.',
        }));
    }

    wakeDeviceForCast(executionSerial);

    if (streamMode === 'screencap') {
        screencapFallbackCount += 1;
        logHub('Cast', `Starting explicit screencap cast for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            source: 'screencap',
            fallback_count: screencapFallbackCount,
        });
        return streamDeviceFramesFallback(req, res, executionSerial);
    }

    const requestStartedAt = Date.now();
    let closed = false;
    let started = false;
    let bootTimer = null;
    let adbExited = false;
    let ffmpegExited = false;
    let fallbackStarted = false;
    let lastError = '';
    let bytesOut = 0;
    let chunkCount = 0;
    let firstFrameAt = null;

    const adbArgs = buildAdbScreenrecordArgs(executionSerial, profile, getScreenrecordDisplayArgs(executionSerial));
    const ffmpegArgs = buildFfmpegArgs(streamMode, profile);

    const adbProc = spawn('adb', adbArgs);
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
    const clearBootTimer = () => {
        if (bootTimer) {
            clearTimeout(bootTimer);
            bootTimer = null;
        }
    };
    const stopper = createStreamStopper({
        adbProc,
        ffmpegProc,
        clearBootTimer,
        onStop: (reason) => {
            activeCastStreams.delete(executionSerial);
            logHub('Cast', `Stopped stream for ${executionSerial}`, {
                reason,
                transport: streamMode,
                profile: profile.key,
                source: 'adb-screenrecord',
            });
        },
    });

    const stopStream = () => {
        closed = true;
        stopper.stop('client_disconnect');
    };

    const fallbackToScreenshots = () => {
        if (closed || started || fallbackStarted) {
            return;
        }

        fallbackStarted = true;
        screencapFallbackCount += 1;
        stopper.stop('fallback_to_screencap');
        console.warn(`[Local Hub] Falling back to screenshot cast for ${executionSerial}: ${lastError || 'video pipeline did not start'}`);
        logHub('Cast', `Falling back to screencap for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            source: 'adb-screenrecord',
            fallback_count: screencapFallbackCount,
            error: lastError || 'video pipeline did not start',
        });
        const fallbackStrategy = getFallbackResponseStrategy(res);
        if (fallbackStrategy === 'abandon') {
            return;
        }
        if (fallbackStrategy === 'close') {
            logHub('Cast', `Closing current response before screencap fallback for ${executionSerial}`, {
                transport: streamMode,
                profile: profile.key,
                reason: 'headers_already_sent',
            });
            safeEnd(res);
            return;
        }
        streamDeviceFramesFallback(req, res, executionSerial, {
            boundary: 'frame',
            sourceLabel: 'screencap-fallback',
        });
    };

    req.on('close', stopStream);
    req.on('aborted', stopStream);

    adbProc.stdout.pipe(ffmpegProc.stdin);

    adbProc.stderr.on('data', (chunk) => {
        lastError += chunk.toString();
        logHub('Cast', `adb screenrecord stderr for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            stderr: chunk.toString(),
        });
    });

    ffmpegProc.stderr.on('data', (chunk) => {
        lastError += chunk.toString();
        logHub('Cast', `ffmpeg stderr for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            stderr: chunk.toString(),
        });
    });

    adbProc.on('error', (err) => {
        lastError = err.message;
        fallbackToScreenshots();
    });

    ffmpegProc.on('error', (err) => {
        lastError = err.message;
        fallbackToScreenshots();
    });

    ffmpegProc.stdout.on('data', (chunk) => {
        if (closed) {
            return;
        }

        bytesOut += chunk.length;
        chunkCount += 1;
        if (!started) {
            started = true;
            clearBootTimer();
            firstFrameAt = Date.now();

            const wroteHeaders = safeWriteHead(res, 200, {
                'Content-Type': streamMode === 'fmp4' ? 'video/mp4' : 'multipart/x-mixed-replace; boundary=ffmpeg',
                'Cache-Control': 'no-store, no-cache, must-revalidate, private',
                'Accept-Ranges': 'none',
                Connection: 'close',
                'X-BizonVR-Cast-Transport': streamMode,
                'X-BizonVR-Cast-Profile': profile.key,
            });
            if (!wroteHeaders) {
                lastError = lastError || 'Failed to send stream headers';
                closed = true;
                stopper.stop('response_header_failure');
                return;
            }
            logHub('Cast', `First stream bytes for ${executionSerial} after ${firstFrameAt - requestStartedAt}ms`, {
                transport: streamMode,
                profile: profile.key,
                source: 'adb-screenrecord',
                output_resolution: profile.size,
                target_fps: profile.fps,
                target_bitrate: profile.bitrate,
            });
        }

        if (!safeWrite(res, chunk)) {
            closed = true;
            stopper.stop('response_write_failure');
        }
    });

    adbProc.on('close', (code, signal) => {
        adbExited = true;
        logHub('Cast', `adb screenrecord exited for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            exit_code: code,
            signal,
            stderr: lastError || null,
            route: executionSerial,
        });
        if (!started) {
            fallbackToScreenshots();
        } else if (ffmpegExited && !closed) {
            safeEnd(res);
        }
    });

    ffmpegProc.on('close', (code, signal) => {
        ffmpegExited = true;
        logHub('Cast', `ffmpeg exited for ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            exit_code: code,
            signal,
            stderr: lastError || null,
            ffmpeg_args: ffmpegArgs,
        });
        if (!started) {
            fallbackToScreenshots();
        } else if (adbExited && !closed) {
            safeEnd(res);
        }
    });

    activeCastStreams.set(executionSerial, {
        transport: streamMode,
        profile: profile.key,
        startedAt: requestStartedAt,
    });
    logHub('Cast', `Starting cast for ${executionSerial}`, {
        transport: streamMode,
        profile: profile.key,
        source: 'adb-screenrecord',
        route: executionSerial,
        output_resolution: profile.size,
        target_fps: profile.fps,
        target_bitrate: profile.bitrate,
        adb_args: adbArgs,
        ffmpeg_args: ffmpegArgs,
    });

    req.on('close', () => {
        const elapsedMs = Math.max(Date.now() - requestStartedAt, 1);
        logHub('Cast', `Client disconnected from ${executionSerial}`, {
            transport: streamMode,
            profile: profile.key,
            first_frame_latency_ms: firstFrameAt ? firstFrameAt - requestStartedAt : null,
            output_chunks: chunkCount,
            output_bytes: bytesOut,
            avg_chunk_bytes: chunkCount ? Math.round(bytesOut / chunkCount) : 0,
            throughput_kbps: Math.round((bytesOut * 8) / elapsedMs),
            errors: lastError || null,
        });
    });

    bootTimer = setTimeout(() => {
        lastError = lastError || `No ${streamMode} bytes were produced within ${STREAM_BOOT_TIMEOUT_MS}ms`;
        fallbackToScreenshots();
    }, STREAM_BOOT_TIMEOUT_MS);
}

async function startAppComponent(deviceSerial, component) {
    if (!component) {
        return { success: true, message: 'No explicit activity provided' };
    }
    logHub('ADB', `Launching component ${component} on ${deviceSerial}`);
    return spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', component], `Started ${component}`);
}

function resolveLaunchComponent(deviceSerial, packageName) {
    if (!packageName) {
        return null;
    }

    try {
        const knownApps = getLaunchableApps(deviceSerial);
        const matched = knownApps.find((app) => app.package === packageName && app.activity);
        if (matched?.activity) {
            return matched.activity;
        }
    } catch (e) {}

    return resolveLaunchComponentDirect(deviceSerial, packageName);
}

function selectExecutionSerial(activeSerials) {
    return activeSerials.find(serial => serial.includes(':')) || activeSerials[0] || '1G0YK01234';
}

function buildAgentStartArgs(deviceSerial, options = {}) {
    const connection = prepareAgentConnection(deviceSerial);
    const args = [
        '-s', deviceSerial,
        'shell', 'am', 'start',
        '-a', 'android.intent.action.MAIN',
        '-c', 'com.oculus.intent.category.VR',
        '-n', buildAgentComponent(),
        '--es', 'HUB_IP', connection.host,
        '--ei', 'HUB_PORT', connection.port,
    ];

    if (options.action) {
        args.push('--es', 'SESSION_ACTION', options.action);
    }
    if (options.pkg) {
        args.push('--es', 'PACKAGE', options.pkg);
    }
    if (options.activity) {
        args.push('--es', 'ACTIVITY', options.activity);
    }
    if (options.duration !== undefined) {
        args.push('--ei', 'DURATION', Number(options.duration));
    }
    if (options.sessionState && typeof options.sessionState === 'object') {
        const state = options.sessionState;
        if (state.session_id !== undefined && state.session_id !== null) {
            args.push('--ei', 'SESSION_ID', Number(state.session_id));
        }
        if (state.remaining_seconds !== undefined && state.remaining_seconds !== null) {
            args.push('--ei', 'REMAINING_SECONDS', Number(state.remaining_seconds));
        }
        if (state.duration_seconds !== undefined && state.duration_seconds !== null) {
            args.push('--ei', 'DURATION_SECONDS', Number(state.duration_seconds));
        }
        if (state.current_app_package) {
            args.push('--es', 'CURRENT_APP_PACKAGE', String(state.current_app_package));
        }
        if (state.current_app_name) {
            args.push('--es', 'CURRENT_APP_NAME', String(state.current_app_name));
        }
        if (state.app_name) {
            args.push('--es', 'APP_NAME', String(state.app_name));
        }
        if (state.session_status) {
            args.push('--es', 'SESSION_STATUS', String(state.session_status));
        }
        if (state.paused !== undefined) {
            args.push('--ez', 'PAUSED', Boolean(state.paused));
        }
    }
    if (options.autoLaunch !== undefined) {
        args.push('--ez', 'AUTO_LAUNCH', Boolean(options.autoLaunch));
    }

    return args;
}

function prepareAgentConnection(deviceSerial) {
    if (isLoopbackHost(HUB_HOST)) {
        throw new Error('Refusing to pass loopback HUB_HOST to Quest Agent. Set HUB_HOST to a LAN IP reachable from the headset.');
    }
    try {
        runAdb(['-s', deviceSerial, 'reverse', `tcp:${LOCAL_SERVER_PORT}`, `tcp:${LOCAL_SERVER_PORT}`], { stdio: 'ignore' });
        logHub('ADB', `Reverse tunnel active for ${deviceSerial} on tcp:${LOCAL_SERVER_PORT}; using LAN callback ${HUB_HOST}:${LOCAL_SERVER_PORT}`);
        return { host: HUB_HOST, port: Number(LOCAL_SERVER_PORT) };
    } catch (e) {
        logHub('ADB', `Reverse tunnel unavailable for ${deviceSerial}, falling back to hub host ${HUB_HOST}:${LOCAL_SERVER_PORT}`);
        return { host: HUB_HOST, port: Number(LOCAL_SERVER_PORT) };
    }
}

async function wakeDevice(deviceSerial) {
    const executionSerial = resolveExecutionSerial(deviceSerial) || deviceSerial;
    logHub('Wake', `Attempting wake for ${deviceSerial} via ${executionSerial}`);
    const wakeResult = await spawnAdb(['-s', executionSerial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 'Wake signal sent');
    if (!wakeResult.success) {
        logHub('Wake', `Wake keyevent failed for ${deviceSerial}`, wakeResult.error);
        return wakeResult;
    }

    const menuResult = await spawnAdb(['-s', executionSerial, 'shell', 'input', 'keyevent', '82'], 'Wake unlock signal sent');
    if (!menuResult.success) {
        logHub('Wake', `Unlock keyevent failed for ${deviceSerial}`, menuResult.error);
        return wakeResult;
    }

    logHub('Wake', `Wake sequence completed for ${deviceSerial} via ${executionSerial}`);
    return wakeResult;
}

function runWithDeviceLock(lockKey, task) {
    const previous = commandLocksByDevice.get(lockKey) || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(task)
        .finally(() => {
            if (commandLocksByDevice.get(lockKey) === next) {
                commandLocksByDevice.delete(lockKey);
            }
        });
    commandLocksByDevice.set(lockKey, next);
    return next;
}

function runCommand(deviceSerial, commandType, payloadStr) {
  return new Promise(async (resolve) => {
     logHub('Command', `Executing ${commandType} on ${deviceSerial}`, payloadStr || '{}');
     
     let payload = {};
     try { payload = JSON.parse(payloadStr || '{}'); } catch(e) {}
     const { stableSerial, selectedRoute } = resolveRouteForCommand(deviceSerial, commandType, payload);
     const adbRoute = selectedRoute;

     if (!['RECONNECT_ADB', 'FORGET_DEVICE', 'RUN_DIAGNOSTICS'].includes(commandType) && !adbRoute) {
        return resolve({ success: false, error: `No stable ADB route is available for ${stableSerial}` });
     }

     if (commandType === 'OPEN_SCRCPY') {
        if (scrcpyProcesses[adbRoute]) {
             return resolve({ success: true, message: "scrcpy already running" });
        }
        const scrcpyArgs = [
            '-s', adbRoute,
            '-b', SCRCPY_BITRATE,
            `--max-size=${SCRCPY_MAX_SIZE}`,
            '--no-audio',
        ];
        if (SCRCPY_CROP) {
            scrcpyArgs.push(`--crop=${SCRCPY_CROP}`);
        }
        const scrcpy = spawn('scrcpy', scrcpyArgs);
        let settled = false;
        scrcpyProcesses[adbRoute] = scrcpy;
        scrcpy.on('error', (err) => {
           console.log(`[scrcpy error] ${err.message}`);
           delete scrcpyProcesses[adbRoute];
           if (!settled) {
               settled = true;
               resolve({ success: false, error: err.message });
           }
        });
        scrcpy.on('spawn', () => {
           if (!settled) {
               settled = true;
               resolve({ success: true, message: "scrcpy spawned" });
           }
        });
        scrcpy.on('close', () => {
           delete scrcpyProcesses[adbRoute];
        });

     } else if (commandType === 'CLOSE_SCRCPY') {
        if (scrcpyProcesses[adbRoute]) {
             scrcpyProcesses[adbRoute].kill();
             delete scrcpyProcesses[adbRoute];
             resolve({ success: true, message: "scrcpy closed" });
        } else {
             resolve({ success: true, message: "scrcpy not running" });
        }

     } else if (commandType === 'START_SESSION') {
        const pkg = payload.package || QUEST_AGENT_PACKAGE;
        const activity = payload.activity || resolveLaunchComponent(deviceSerial, pkg);
        const duration = payload.duration_minutes || 30;
        const sessionState = payload.session_state || null;
        
        logHub('Session', `Notifying Agent to start session on ${adbRoute}`, { pkg, activity, duration });
        wakeDevice(stableSerial).then((wakeRes) => {
            if (!wakeRes.success) {
                return resolve(wakeRes);
            }

            return spawnAdb(buildAgentStartArgs(adbRoute, {
                action: 'START',
                pkg,
                activity,
                duration,
                sessionState,
                autoLaunch: false,
            }), `Agent notified for ${pkg}`)
                .then(async (res) => {
                    if (!res.success) {
                        return resolve(res);
                    }

                    if (!activity) {
                        return resolve({
                            success: false,
                            error: `Launch activity not found for ${pkg}`,
                        });
                    }

                    // Launch through ADB as well so already-installed agent builds work immediately.
                    const launchRes = await startAppComponent(adbRoute, activity);
                    resolve(launchRes.success ? res : launchRes);
                });
        }).catch((err) => resolve({ success: false, error: err.message }));

     } else if (commandType === 'PAUSE_SESSION') {
        const pkg = payload.package || payload.current_app_package;
        const finishWithLauncher = () => spawnAdb(buildAgentStartArgs(adbRoute, {
            action: 'PAUSE',
            pkg,
            sessionState: payload.session_state || null,
            autoLaunch: false,
        }), 'Session paused in Agent').then(resolve);

        if (!pkg || !isValidPackage(pkg)) {
            return finishWithLauncher();
        }

        const stop = spawn('adb', ['-s', adbRoute, 'shell', 'am', 'force-stop', pkg]);
        let stderr = '';
        stop.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        stop.on('close', (code) => {
           if (code !== 0) {
               return resolve({ success: false, error: stderr.trim() || `force-stop exited with code ${code}` });
           }
           finishWithLauncher();
        });
        stop.on('error', (err) => resolve({ success: false, error: err.message }));

     } else if (commandType === 'RESUME_SESSION') {
        const pkg = payload.current_app_package || payload.package || QUEST_AGENT_PACKAGE;
        const activity = payload.activity || resolveLaunchComponent(deviceSerial, pkg);
        logHub('Session', `Resuming session on ${adbRoute}`, { pkg, activity });
        return spawnAdb(buildAgentStartArgs(adbRoute, {
            action: 'RESUME',
            pkg,
            activity,
            sessionState: payload.session_state || null,
            autoLaunch: false,
        }), `Agent resumed session for ${pkg}`)
            .then(async (res) => {
                if (!res.success) {
                    return resolve(res);
                }
                if (!activity) {
                    return resolve({
                        success: false,
                        error: `Launch activity not found for ${pkg}`,
                    });
                }
                const launchRes = await startAppComponent(adbRoute, activity);
                resolve(launchRes.success ? res : launchRes);
            });

     } else if (commandType === 'SWITCH_SESSION_APP') {
        const pkg = payload.package || payload.current_app_package;
        const activity = payload.activity || resolveLaunchComponent(deviceSerial, pkg);
        const launchImmediately = Boolean(payload.launch_immediately);
        logHub('Session', `Switching session app on ${adbRoute}`, { pkg, activity, launchImmediately });
        return spawnAdb(buildAgentStartArgs(adbRoute, {
            action: launchImmediately ? 'SWITCH' : 'SYNC',
            pkg,
            activity,
            sessionState: payload.session_state || null,
            autoLaunch: false,
        }), `Agent synced session app ${pkg}`)
            .then(async (res) => {
                if (!res.success || !launchImmediately) {
                    return resolve(res);
                }
                if (!activity) {
                    return resolve({
                        success: false,
                        error: `Launch activity not found for ${pkg}`,
                    });
                }
                const launchRes = await startAppComponent(adbRoute, activity);
                resolve(launchRes.success ? res : launchRes);
            });

     } else if (commandType === 'END_SESSION') {
        const pkg = payload.package;
        if (!isValidPackage(pkg)) return resolve({ success: false, error: "Invalid package name" });
        
        logHub('Session', `Stopping package ${pkg} on ${adbRoute}`);
        
        const stop = spawn('adb', ['-s', adbRoute, 'shell', 'am', 'force-stop', pkg]);
        let stderr = '';
        stop.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        stop.on('close', (code) => {
           if (code !== 0) {
               return resolve({ success: false, error: stderr.trim() || `force-stop exited with code ${code}` });
           }
           // Wait a second then launch the club launcher setting the intent action to stop
           setTimeout(() => {
               spawnAdb(buildAgentStartArgs(adbRoute, {
                   action: 'STOP',
                   sessionState: payload.session_state || null,
                   autoLaunch: false,
               }), "Session ended, launcher started")
                  .then(resolve);
           }, 1000);
        });
        stop.on('error', (err) => resolve({ success: false, error: err.message }));

     } else if (commandType === 'INSTALL_APP') {
        const apkPath = payload.apkPath;
        if (!apkPath) return resolve({ success: false, error: "Missing apkPath" });
        logHub('ADB', `Installing APK ${apkPath} on ${adbRoute}`);
        spawnAdb(['-s', adbRoute, 'install', '-r', apkPath], "APK Installed")
            .then(resolve);

     } else if (commandType === 'INSTALL_APK') {
        const agentPkg = payload.package_name || QUEST_AGENT_PACKAGE;
        if (!isValidPackage(agentPkg)) return resolve({ success: false, error: "Invalid package name" });
        if (!payload.apk_checksum) return resolve({ success: false, error: "Missing APK checksum in command payload" });
        if (!fs.existsSync(QUEST_AGENT_APK_PATH)) {
            return resolve({ success: false, error: `APK artifact not found at ${QUEST_AGENT_APK_PATH}` });
        }
        const actualChecksum = sha256File(QUEST_AGENT_APK_PATH);
        if (actualChecksum !== payload.apk_checksum) {
            return resolve({
                success: false,
                error: `APK checksum mismatch for ${agentPkg}: expected ${payload.apk_checksum}, got ${actualChecksum}`,
            });
        }
        logHub('Agent', `Installing Quest Agent on ${adbRoute}`);
        spawnAdb(['-s', adbRoute, 'install', '-r', QUEST_AGENT_APK_PATH], `Installed Agent`)
            .then((res) => {
                if(res.success) {
                    logHub('Agent', `Starting Quest Agent on ${adbRoute}`);
                    spawnAdb(buildAgentStartArgs(adbRoute), `Started Agent installed`)
                       .then(resolve);
                } else {
                    resolve(res);
                }
            })

     } else if (commandType === 'UNINSTALL_APP') {
        const pkg = payload.package;
        if (!isValidPackage(pkg)) return resolve({ success: false, error: "Invalid package name" });
        logHub('ADB', `Uninstalling package ${pkg} on ${adbRoute}`);
        spawnAdb(['-s', adbRoute, 'uninstall', pkg], `Uninstalled ${pkg}`)
            .then(resolve);

     } else if (commandType === 'OPEN_LAUNCHER') {
        spawnAdb(buildAgentStartArgs(adbRoute), "Launcher started")
            .then(resolve);

     } else if (commandType === 'REBOOT_DEVICE') {
        spawnAdb(['-s', adbRoute, 'reboot'], "Device rebooting")
            .then(resolve);

     } else if (commandType === 'REFRESH_STATUS') {
        if (payload.wake_device) {
            wakeDevice(stableSerial).then((result) => {
                if (!result.success) {
                    return resolve(result);
                }
                setTimeout(() => resolve({ success: true, message: "device awakened and status refresh scheduled" }), 1000);
            });
            return;
        }

        if (payload.repair_wireless) {
            try {
                const usbSerial = payload.usb_serial || deviceRoutingIndex[stableSerial]?.usbSerial || stableSerial;
                const stableSerial = payload.stable_serial || getDeviceStableSerial(usbSerial);
                const wifiDetails = getDeviceWifiDetails(usbSerial);
                rememberWirelessRoute(stableSerial, {
                    usbSerial,
                    ip: wifiDetails.ip,
                    wifiSsid: wifiDetails.wifiSsid ?? null,
                    androidId: getDeviceAndroidId(usbSerial),
                    model: getDeviceModel(usbSerial),
                    knownDevice: true,
                });
                setupWirelessAdb(usbSerial, wifiDetails, { force: true });
                setTimeout(() => resolve({ success: true, message: "USB repair started. Local Hub will reconnect Wi-Fi ADB." }), 1200);
            } catch (e) {
                resolve({ success: false, error: `USB repair failed: ${e.message}` });
            }
            return;
        }

        setTimeout(() => resolve({ success: true, message: "status refreshed" }), 1000);

     } else if (commandType === 'RECONNECT_ADB') {
        const reconnectStableSerial = payload.stable_serial || stableSerial;
        const route = deviceRoutingIndex[reconnectStableSerial] || {
            stableSerial: reconnectStableSerial,
            ip: wirelessStateIndex[reconnectStableSerial]?.ip || null,
            wirelessSerial: wirelessStateIndex[reconnectStableSerial]?.wirelessSerial || null,
            androidId: wirelessStateIndex[reconnectStableSerial]?.androidId || null,
            agentOnline: Boolean(Object.values(agentHeartbeats).find((heartbeat) => heartbeat.stable_id === reconnectStableSerial)),
        };
        const reconnectState = await adbSupervisor.forceReconnect(reconnectStableSerial, {
            route,
            heartbeatIp: findAgentHeartbeatForRoute(route)?.local_ip || null,
        });
        refreshDeviceRouting(false);
        resolve(reconnectState?.status === 'online'
            ? { success: true, message: "ADB reconnect attempted using remembered Wi-Fi routes" }
            : { success: false, error: reconnectState?.lastError || "No remembered Wi-Fi route could be reconnected. Connect USB and run Repair via USB." });

     } else if (commandType === 'RELAUNCH_AGENT') {
        const executionSerial = resolveExecutionSerial(stableSerial) || adbRoute;
        if (!isValidDeviceSerial(executionSerial)) {
            return resolve({ success: false, error: "No valid ADB route is available to relaunch Quest Agent" });
        }
        spawnAdb(buildAgentStartArgs(executionSerial), "Quest Agent relaunched")
            .then(resolve);

     } else if (commandType === 'RUN_DIAGNOSTICS') {
        refreshDeviceRouting(false);
        const route = deviceRoutingIndex[stableSerial] || Object.values(deviceRoutingIndex).find((entry) => entry.executionSerial === stableSerial);
        if (!route) {
            return resolve({ success: false, error: "Device route not found for diagnostics" });
        }
        route.agentOnline = Boolean(findAgentHeartbeatForRoute(route));
        const routeHealth = summarizeRouteHealth(route);
        resolve({
            success: true,
            message: JSON.stringify({
                connection_status: routeHealth.connection_status,
                what_works: {
                    adb: routeHealth.adb_status === 'online',
                    agent: routeHealth.agent_status === 'online',
                    wifi_ready: routeHealth.wifi_ready,
                },
                probable_cause: routeHealth.status_reason,
                next_step: routeHealth.next_step,
            }),
        });

     } else if (commandType === 'FORGET_DEVICE') {
        const stableSerial = payload.stable_serial || deviceSerial;
        const agentId = payload.agent_id || null;
        const ignoredTransportId = deviceRoutingIndex[stableSerial]?.transportId || null;
        wirelessStateIndex[stableSerial] = {
            stableSerial,
            agentId,
            ignored: true,
            ignoredAt: Date.now(),
            ignoredTransportId,
            readyForRediscovery: false,
        };
        saveWirelessStateIndex();
        delete deviceRoutingIndex[stableSerial];
        if (agentId) {
            delete agentHeartbeats[agentId];
            delete lastHeartbeatLogAtByAgent[agentId];
        }
        resolve({ success: true, message: `Forgot remembered Quest ${stableSerial}` });

     } else {
        resolve({ success: false, error: "unknown command" });
     }
  });
}

function bootstrapKnownDevices() {
    if (knownDevicesBootstrapped) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const protocol = API_URL.startsWith('https') ? https : http;
        const req = protocol.request(`${API_URL}/api/devices`, {
            method: 'GET',
            timeout: BOOTSTRAP_TIMEOUT_MS,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const devices = JSON.parse(data);
                    if (Array.isArray(devices)) {
                        for (const device of devices) {
                            const stableSerial = device.stable_id || device.serial_number;
                            if (!stableSerial) {
                                continue;
                            }
                            rememberWirelessRoute(stableSerial, {
                                knownDevice: true,
                                usbSerial: device.serial_number || null,
                                ip: device.last_known_ip || device.wifi_ip || device.ip_address || null,
                                previousIps: Array.isArray(device.previous_ips) ? device.previous_ips : [],
                                wifiSsid: device.wifi_ssid || null,
                                agentId: device.agent_id || device.pairing_id || null,
                                androidId: device.android_id || null,
                                model: device.model || 'Meta Quest',
                                hadSuccessfulWifiConnection: Boolean(device.last_known_ip || device.wifi_ip || device.ip_address),
                            });
                        }
                    }
                    knownDevicesBootstrapped = true;
                } catch (e) {
                    console.warn(`[Bootstrap] Failed to parse known devices: ${e.message}`);
                }
                resolve();
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('bootstrap timeout'));
        });
        req.on('error', (err) => {
            console.warn(`[Bootstrap] Failed to load known devices: ${err.message}`);
            resolve();
        });
        req.end();
    });
}

function findAgentHeartbeatForRoute(route) {
    const heartbeats = Object.values(agentHeartbeats);
    const matched = heartbeats.find((heartbeat) => {
        if (route.agentId && (heartbeat.agent_id === route.agentId || heartbeat.pairing_id === route.agentId)) {
            return true;
        }
        if (!route.agentId && route.stableSerial && heartbeat.stable_id === route.stableSerial) {
            return true;
        }
        if (!route.agentId && route.androidId && heartbeat.android_id === route.androidId) {
            return true;
        }
        return false;
    });
    if (matched) {
        return matched;
    }

    return null;
}

function syncWithCloud() {
   const protocol = API_URL.startsWith('https') ? https : http;
   const activeSerials = getAdbDevices();
   const deviceRoutes = Object.values(deviceRoutingIndex);
   (async () => {
   const deviceDetails = [];
   for (const route of deviceRoutes) {
       const heartbeat = findAgentHeartbeatForRoute(route);
       route.agentOnline = Boolean(heartbeat);
       if (heartbeat?.agent_id || heartbeat?.pairing_id) {
           route.agentId = heartbeat.agent_id || heartbeat.pairing_id;
           rememberWirelessRoute(route.stableSerial, { agentId: route.agentId });
       }
       await adbSupervisor.tick(route, { route, heartbeatIp: heartbeat?.local_ip || null });
       const executionSerial = route.executionSerial || route.stableSerial;
       const routeHealth = summarizeRouteHealth(route);
       maybeAutoStartAgent(route, routeHealth);
       let battery = 85;
       let installedApps = [];
       if (executionSerial && executionSerial !== '1G0YK01234' && routeHealth.adb_status === 'online') {
           try {
               const batteryOut = runAdbCapture(['-s', executionSerial, 'shell', 'dumpsys', 'battery']);
               const match = batteryOut.match(/level:\s*(\d+)/);
               if (match) battery = parseInt(match[1], 10);
           } catch(e) {
               console.warn(`[WARN] ADB dumpsys failed for ${executionSerial}`);
           }
           installedApps = getLaunchableApps(executionSerial);
       }
       deviceDetails.push({
           serial: route.stableSerial,
           stable_id: route.stableSerial,
           usb_serial: route.usbSerial || route.stableSerial,
           agent_id: route.agentId || null,
           android_id: route.androidId || null,
           model: route.model || 'Meta Quest',
           battery,
           installed_apps: installedApps,
           wifi_ssid: route.wifiSsid || null,
           ip_address: routeHealth.wifi_ip,
           previous_ips: routeHealth.previous_ips || [],
           active_route: route.executionSerial || route.wirelessSerial || route.usbSerial || null,
           adb_status: routeHealth.adb_status,
           agent_status: routeHealth.agent_status,
           connection_status: routeHealth.connection_status,
           wifi_ready: routeHealth.wifi_ready,
           usb_repair_required: routeHealth.usb_repair_required,
           status_reason: routeHealth.status_reason,
           next_step: routeHealth.next_step,
           transport: routeHealth.transport,
           wake_supported: routeHealth.wake_supported,
           ip_changed: routeHealth.ip_changed,
           app_version: heartbeat?.app_version || null,
           adb_recovery_status: routeHealth.adb_recovery_status || null,
           adb_recovery_permission: routeHealth.adb_recovery_permission || null,
       });
   }

   const now = Date.now();
   for (const key in agentHeartbeats) {
       if (now - agentHeartbeats[key].last_seen > 30000) {
           delete agentHeartbeats[key];
       }
   }

   const requestData = JSON.stringify({ 
       active_serials: activeSerials, 
       device_details: deviceDetails,
       agent_heartbeats: Object.values(agentHeartbeats),
       hub_host: HUB_HOST,
       hub_port: Number(LOCAL_SERVER_PORT),
   });

   const req = protocol.request(`${API_URL}/api/hubs/${HUB_ID}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': requestData.length
      }
   }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
         try {
            const json = JSON.parse(data);
            const commands = json.commands || [];
            logHub('Sync', `Cloud sync completed with ${commands.length} pending command(s)`, {
                activeSerials,
                heartbeats: Object.keys(agentHeartbeats).length,
            });
            
            for (const cmd of commands) {
               logHub('Command', `Received command ${cmd.type}#${cmd.id} for device ${cmd.device_id}`);

               const targetStableSerial = typeof cmd.device_serial_number === 'string'
                   ? cmd.device_serial_number
                   : selectExecutionSerial(activeSerials);
               const executionSerial = targetStableSerial ? resolveExecutionSerial(targetStableSerial) : null;
               logHub('Routing', `Resolved command route for ${cmd.type}#${cmd.id}`, {
                   targetStableSerial,
                   executionSerial,
               });

               const canRunWithoutCurrentRoute = ['RECONNECT_ADB', 'FORGET_DEVICE'].includes(String(cmd.type));
               if (!executionSerial && !canRunWithoutCurrentRoute) {
                   await reportCommandStatus(cmd.id, 'failed', 'Device is unreachable over USB/Wi-Fi ADB. Reconnect the headset or re-enable wireless debugging.');
                   continue;
               }

               await reportCommandStatus(cmd.id, 'running');
               const commandRoute = executionSerial || targetStableSerial;
               const result = await runWithDeviceLock(targetStableSerial || commandRoute, () => runCommand(commandRoute, cmd.type, cmd.payload));
               logHub('Command', `Finished ${cmd.type}#${cmd.id} on ${commandRoute}`, result);
               
               // Report success/fail back to API
               await reportCommandStatus(cmd.id, result.success ? 'succeeded' : 'failed', result.error);
            }
         } catch(e) {
            console.error('Failed to parse sync response', e.message);
         }
      });
   });
   
   req.on('error', (e) => {
      console.error('Local Hub sync error:', e.message);
   });
   
   req.write(requestData);
   req.end();
   })().catch((error) => {
      console.error('Local Hub sync build error:', error instanceof Error ? error.message : String(error));
   });
}

function reportCommandStatus(cmdId, status, errorMsg) {
   return new Promise((resolve) => {
      const protocol = API_URL.startsWith('https') ? https : http;
      const data = JSON.stringify({ status, error_message: errorMsg });
      logHub('Command', `Reporting command ${cmdId} status ${status}`, errorMsg ? { error: errorMsg } : undefined);
      
      const req = protocol.request(`${API_URL}/api/commands/${cmdId}/status`, {
         method: 'POST',
         headers: { 
           'Content-Type': 'application/json',
           'Content-Length': Buffer.byteLength(data)
         }
      });
      req.write(data);
      req.on('close', resolve);
      req.on('error', resolve);
      req.end();
   });
}

// --- Local Hub Mini-Server ---
const localServer = http.createServer((req, res) => {
    // CORS headers for local network just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    if (req.method === 'GET' && req.url.startsWith('/streams/')) {
        const streamUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const serial = decodeURIComponent(streamUrl.pathname.replace('/streams/', ''));
        if (!isValidDeviceSerial(serial)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: 'INVALID_DEVICE_SERIAL',
                next_step: 'Refresh devices in the panel and retry the cast.',
            }));
        }

        return streamDeviceFrames(
            req,
            res,
            serial,
            streamUrl.searchParams.get('transport') || STREAM_MODE,
            streamUrl.searchParams.get('profile') || STREAM_PROFILE,
        );
    }

    if (req.method === 'POST' && req.url === '/api/agent/heartbeat') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ip = req.socket.remoteAddress;
                const id = buildHeartbeatIdentity(data);
                if (isIgnoredDevice(data.stable_id || null, data.agent_id || data.pairing_id || null)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, ignored: true }));
                }
                if (!id) {
                    logHub('Heartbeat', 'Rejected heartbeat without stable identity', { ip });
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        error: 'IDENTITY_REQUIRED',
                        message: 'Heartbeat must include agent_id, pairing_id, stable_id, or android_id.',
                    }));
                }
                agentHeartbeats[id] = {
                    ...data,
                    agent_id: data.agent_id || data.pairing_id || null,
                    ip,
                    local_ip: data.local_ip || null,
                    app_version: data.app_version || null,
                    last_seen: Date.now()
                };

                const lastLoggedAt = Number(lastHeartbeatLogAtByAgent[id] || 0);
                if ((Date.now() - lastLoggedAt) >= HEARTBEAT_LOG_INTERVAL_MS) {
                    logHub('Heartbeat', `Agent ${id} heartbeat`, {
                        ip,
                        inSession: Boolean(data.in_session),
                        sessionSeconds: Number(data.session_seconds || 0),
                    });
                    lastHeartbeatLogAtByAgent[id] = Date.now();
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/agent/call_operator') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ip = req.socket.remoteAddress;
                const id = buildHeartbeatIdentity(data) || 'unknown-agent';
                logHub('Agent', `Agent ${id} called operator`, { ip });
                
                // Forward to cloud
                const protocol = API_URL.startsWith('https') ? https : http;
                const reqOption = {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json'
                    }
                };
                if (HUB_TOKEN) {
                    reqOption.headers.Authorization = `Bearer ${HUB_TOKEN}`;
                }
                const cloudReq = protocol.request(`${API_URL}/api/hub/call_operator`, reqOption, (cloudRes) => {});
                cloudReq.on('error', (err) => console.error('[Local Hub] Error forwarding call_operator:', err.message));
                cloudReq.write(JSON.stringify({ pairing_id: data.pairing_id }));
                cloudReq.end();
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

localServer.on('error', (err) => {
    console.error(`[Local Hub Mini-Server] Failed to start on port ${LOCAL_SERVER_PORT}: ${err.message}`);
});

localServer.listen(LOCAL_SERVER_PORT, '0.0.0.0', () => {
    console.log(`[Local Hub Mini-Server] Listening for Agent heartbeats on port ${LOCAL_SERVER_PORT}`);

    // Start polling only after the local callback server is ready so Agent reverse
    // tunnels and heartbeat posts have a live target immediately.
    bootstrapKnownDevices().finally(() => {
        setInterval(syncWithCloud, POLL_INTERVAL_MS);
        syncWithCloud();
    });
});
