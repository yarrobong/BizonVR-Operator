import https from 'https';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { createAdbProcessRunner, isAdbTransportFailure } from './adb-process-runner.js';
import { executeWithAdbRecovery, isSafeAdbRetry } from './adb-command-executor.js';
import { buildHeartbeatIdentity, prefersUsbForCommand, selectPreferredExecutionRoute } from './route-selection.js';
import { createAdbSupervisor } from './adb-supervisor.js';
import { createExecutionStore, getCommandPolicy } from './command-reliability.js';
import { checkAdbRecoveryPermission, reportAdbRecoveryStatus, tryEnableWirelessAdb } from './adb-recovery-adapter.js';
import { createCastManager, terminateOwnedProcess } from './cast-manager.js';
import {
    buildAdbScreenrecordArgs,
    buildFfmpegArgs,
    getStreamProfile,
    resolveStreamRequest,
    safeEnd,
    safeWriteHead,
} from './streaming.js';
import { DEFAULT_CAST_PROFILE, DEFAULT_CAST_TRANSPORT } from '../src/shared/cast-config.js';
import { resolveApprovedApk } from './apk-security.js';

function readCastNumber(name, fallback, minimum = 0) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= minimum ? value : fallback;
}

const HUB_ID = Number(process.env.HUB_ID || 1);
const API_URL = process.env.APP_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 5000;
const LOCAL_SERVER_PORT = process.env.HUB_PORT || 3001;
const HUB_HOST = resolveHubHost();
const HUB_TOKEN = process.env.HUB_TOKEN || (() => {
    try { return JSON.parse(process.env.HUB_TOKENS_JSON || '{}')[String(HUB_ID)] || ''; } catch { return ''; }
})();
const QUEST_AGENT_PACKAGE = process.env.QUEST_AGENT_PACKAGE || 'com.bizonvr.spatialspike';
const QUEST_AGENT_MAIN_ACTIVITY = process.env.QUEST_AGENT_MAIN_ACTIVITY || '.SpatialLauncherActivity';
const APK_ARTIFACT_ROOT = path.resolve(process.env.APK_CACHE_ROOT || path.join(process.cwd(), '.cache', 'local-hub', 'apks'));
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
const AGENT_JSON_BODY_LIMIT = readCastNumber('AGENT_JSON_BODY_LIMIT', 32 * 1024, 1024);
const AGENT_HEARTBEAT_MAX_AGE_MS = readCastNumber('AGENT_HEARTBEAT_MAX_AGE_MS', 60000, 1000);
const CAST_MAX_CONCURRENT = readCastNumber('MAX_CONCURRENT_CASTS', 4, 1);
const CAST_MAX_VIEWERS = readCastNumber('MAX_CAST_VIEWERS', 4, 1);
const CAST_TERM_GRACE_MS = readCastNumber('CAST_TERM_GRACE_MS', 1000);
const CAST_KILL_GRACE_MS = readCastNumber('CAST_KILL_GRACE_MS', 1000);
const CAST_NO_VIEWER_STOP_MS = readCastNumber('CAST_NO_VIEWER_STOP_MS', 1000);
const CAST_SLOW_VIEWER_TIMEOUT_MS = readCastNumber('CAST_SLOW_VIEWER_TIMEOUT_MS', 5000, 1);
const CAST_MAX_PENDING_BYTES = readCastNumber('CAST_MAX_PENDING_BYTES', 2 * 1024 * 1024, 1024);
const CAST_RECOVERY_ATTEMPTS = readCastNumber('CAST_RECOVERY_ATTEMPTS', 3);
const CAST_RECOVERY_BASE_DELAY_MS = readCastNumber('CAST_RECOVERY_BASE_DELAY_MS', 250);
const ADB_EXECUTABLE = process.env.ADB_EXECUTABLE || 'adb';
const FFMPEG_EXECUTABLE = process.env.FFMPEG_EXECUTABLE || 'ffmpeg';
const SCRCPY_EXECUTABLE = process.env.SCRCPY_EXECUTABLE || 'scrcpy';
const STREAM_MODE = process.env.STREAM_MODE || DEFAULT_CAST_TRANSPORT;
const STREAM_PROFILE = process.env.STREAM_PROFILE || DEFAULT_CAST_PROFILE;
const STREAM_DISPLAY_ID = process.env.STREAM_DISPLAY_ID || '';
const ICON_CACHE_ROOT = path.resolve(process.cwd(), '.cache', 'apk-icons');
const APK_CACHE_ROOT = path.join(ICON_CACHE_ROOT, 'apks');
const ICON_PUBLIC_ROOT = path.resolve(process.cwd(), 'public', 'app-icons');
const ICON_CACHE_INDEX_PATH = path.join(ICON_CACHE_ROOT, 'index.json');
const WIRELESS_STATE_PATH = path.resolve(process.cwd(), '.cache', 'local-hub', 'wireless-state.json');
const AGENT_CREDENTIALS_PATH = path.resolve(process.cwd(), '.cache', 'local-hub', 'agent-credentials.json');
const COMMAND_STATE_PATH = path.resolve(process.cwd(), '.cache', 'local-hub', 'command-state.sqlite');
const WIRELESS_SETUP_RETRY_MS = Number(process.env.WIRELESS_SETUP_RETRY_MS || 60000);
const WIRELESS_ADB_PORT = Number(process.env.WIRELESS_ADB_PORT || 5555);
const HEARTBEAT_LOG_INTERVAL_MS = Number(process.env.HEARTBEAT_LOG_INTERVAL_MS || 15000);
const BOOTSTRAP_TIMEOUT_MS = Number(process.env.BOOTSTRAP_TIMEOUT_MS || 5000);
const ADB_COMMAND_TIMEOUT_MS = Number(process.env.ADB_COMMAND_TIMEOUT_MS || 5000);
const AUTO_START_AGENT_RETRY_MS = Number(process.env.AUTO_START_AGENT_RETRY_MS || 20000);
const AGENT_PACKAGES = new Set(['com.bizonvr.spatialspike', QUEST_AGENT_PACKAGE]);
const adbProcessRunner = createAdbProcessRunner({ defaultTimeoutMs: ADB_COMMAND_TIMEOUT_MS });
const executionStore = createExecutionStore(process.env.COMMAND_STATE_PATH || COMMAND_STATE_PATH);
executionStore.prune();

// This is intentionally process-scoped: a second Hub process on the same
// computer must not look like the first owner of a live lease.
const HUB_INSTANCE_ID = process.env.HUB_INSTANCE_ID || crypto.randomUUID();

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
let agentCredentials = loadAgentCredentials();
const deviceAppCache = {};
const iconCacheIndex = loadIconCacheIndex();
const wirelessStateIndex = loadWirelessStateIndex();
let deviceRoutingIndex = {};
let lastHeartbeatLogAtByAgent = {};
let knownDevicesBootstrapped = false;
const autoStartInFlightByStableSerial = {};
const commandLocksByDevice = new Map();
const adbCommandMetricsByStableSerial = new Map();
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
            await runAdbCapture(['disconnect', serial]);
            return { success: true };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    },
    adbConnect: async (serial) => {
        try {
            const message = await runAdbCapture(['connect', serial]);
            const normalized = String(message).toLowerCase();
            const success = normalized.includes('connected to') || normalized.includes('already connected to');
            if (!success) {
                return { success: false, message: String(message).trim() || `ADB connect failed for ${serial}.` };
            }
            for (let attempt = 0; attempt < 4; attempt += 1) {
                if (await isAdbRouteOnline(serial)) {
                    return { success: true, message: String(message).trim() };
                }
                await delay(250);
            }
            return { success: false, message: `Connected ${serial} but adb get-state did not stabilize.` };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    },
    verifyRouteIdentity: async ({ serial, expectedStableId, expectedAndroidId }) => {
        const stableId = await getDeviceStableSerial(serial) || null;
        const androidId = await getDeviceAndroidId(serial) || null;
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
const castManager = createCastManager({
    maxConcurrentCasts: CAST_MAX_CONCURRENT,
    maxViewersPerCast: CAST_MAX_VIEWERS,
    bootTimeoutMs: STREAM_BOOT_TIMEOUT_MS,
    termGraceMs: CAST_TERM_GRACE_MS,
    killGraceMs: CAST_KILL_GRACE_MS,
    noViewerStopMs: CAST_NO_VIEWER_STOP_MS,
    slowViewerTimeoutMs: CAST_SLOW_VIEWER_TIMEOUT_MS,
    maxPendingBytes: CAST_MAX_PENDING_BYTES,
    recoveryAttempts: CAST_RECOVERY_ATTEMPTS,
    recoveryBaseDelayMs: CAST_RECOVERY_BASE_DELAY_MS,
    resolveRoute: async ({ record }) => {
        const route = await resolveExecutionSerial(record.key);
        if (!route) return null;
        const actualStable = await getDeviceStableSerial(route);
        if (!actualStable || actualStable !== record.key) {
            logHub('Cast', 'Refusing recovery on a route with mismatched identity', {
                castId: record.castId,
                stableSerial: record.key,
                route,
                actualStable,
                errorCode: 'DEVICE_IDENTITY_MISMATCH',
            });
            return null;
        }
        return route;
    },
    log: (scope, message, extra) => logHub(scope, message, extra),
});
const scrcpyProcesses = new Map();
const activeCastStreams = castManager.getRegistry();
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
        path.join(APK_ARTIFACT_ROOT, 'quest-agent.apk'),
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

function loadAgentCredentials() {
    try { return JSON.parse(fs.readFileSync(AGENT_CREDENTIALS_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveAgentCredentials() {
    ensureDir(path.dirname(AGENT_CREDENTIALS_PATH));
    fs.writeFileSync(AGENT_CREDENTIALS_PATH, JSON.stringify(agentCredentials, null, 2), { mode: 0o600 });
    try { fs.chmodSync(AGENT_CREDENTIALS_PATH, 0o600); } catch (e) {}
}

function hashAgentToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function rememberAgentCredential(stableSerial, payload) {
    const token = typeof payload?.agent_token === 'string' ? payload.agent_token : '';
    if (!token || !stableSerial) return;
    agentCredentials[stableSerial] = {
        token,
        tokenHash: hashAgentToken(token),
        pairingId: payload.pairing_id || null,
        agentId: payload.agent_id || null,
        stableId: stableSerial,
        lastTimestamp: 0,
    };
    saveAgentCredentials();
}

function verifyAgentRequest(req, data) {
    const presented = /^Bearer (.+)$/.exec(String(req.headers.authorization || '').trim())?.[1] || '';
    if (!presented) return { ok: false, status: 401 };
    const candidates = [data.pairing_id, data.agent_id, data.stable_id, data.android_id].filter(Boolean).map(String);
    if (candidates.length === 0) return { ok: false, status: 401 };
    const record = Object.values(agentCredentials).find((entry) => {
        const knownIdentities = new Set([entry.pairingId, entry.agentId, entry.stableId, entry.androidId].filter(Boolean).map(String));
        return candidates.every((candidate) => knownIdentities.has(String(candidate)));
    });
    if (!record) return { ok: false, status: 401 };
    const actual = Buffer.from(hashAgentToken(presented));
    const expected = Buffer.from(String(record.tokenHash || ''));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { ok: false, status: 401 };
    if (data.timestamp === undefined) return { ok: false, status: 408 };
    {
        const timestamp = Number(data.timestamp);
        const now = Date.now();
        if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > AGENT_HEARTBEAT_MAX_AGE_MS) return { ok: false, status: 408 };
        if (Number(record.lastTimestamp || 0) >= timestamp) return { ok: false, status: 409 };
        record.lastTimestamp = timestamp;
        saveAgentCredentials();
    }
    return { ok: true, record };
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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            totalBytes += Buffer.byteLength(chunk);
            if (totalBytes > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            if (tooLarge) {
                const error = new Error('Request body is too large');
                error.statusCode = 413;
                return reject(error);
            }
            try { return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (error) { return reject(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 })); }
        });
        req.on('error', reject);
    });
}

function pushPreviousIps(state, nextIp) {
    return normalizeIpList([nextIp, ...(state?.previousIps || []), state?.ip]).slice(0, 8);
}

async function runAdbCapture(args, options = {}) {
    return adbProcessRunner.capture(args, {
        timeoutMs: options.timeoutMs || ADB_COMMAND_TIMEOUT_MS,
        maxStdoutBytes: options.maxStdoutBytes,
        maxStderrBytes: options.maxStderrBytes,
        spawnOptions: options.spawnOptions,
    });
}

async function runAdb(args, options = {}) {
    return runAdbCapture(args, options);
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

async function listAdbDevicesDetailed() {
    try {
        return parseAdbDevices(await runAdbCapture(['devices', '-l']));
    } catch (e) {
        logHub('ADB', 'ADB device discovery failed', { error: e instanceof Error ? e.message : String(e), category: e?.timedOut ? 'process_timeout' : 'adb_error' });
        return [];
    }
}

async function getDeviceWifiDetails(serial) {
    const details = { ip: null, wifiSsid: null };

    try {
        const out = await runAdbCapture(['-s', serial, 'shell', 'ip', 'addr', 'show', 'wlan0']);
        const match = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) {
            details.ip = match[1];
        }
    } catch (e) {}

    try {
        const wifiStatus = await runAdbCapture(['-s', serial, 'shell', 'cmd', 'wifi', 'status']);
        const ssidMatch = wifiStatus.match(/SSID:\s+"([^"]+)"/) || wifiStatus.match(/SSID:\s+([^\n,]+)/);
        if (ssidMatch) {
            details.wifiSsid = ssidMatch[1].trim().replace(/^"|"$/g, '');
        }
    } catch (e) {}

    return details;
}

async function getDeviceStableSerial(serial) {
    try {
        const stableSerial = (await runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.serialno'])).trim();
        return stableSerial || serial;
    } catch (e) {
        return null;
    }
}

async function getDeviceAndroidId(serial) {
    try {
        return (await runAdbCapture(['-s', serial, 'shell', 'settings', 'get', 'secure', 'android_id'])).trim() || null;
    } catch (e) {
        return null;
    }
}

async function getDeviceModel(serial) {
    try {
        return (await runAdbCapture(['-s', serial, 'shell', 'getprop', 'ro.product.model'])).trim() || 'Meta Quest';
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

async function findCanonicalStableSerialForState(stableSerial, state) {
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
        const liveStable = await getDeviceStableSerial(state.wirelessSerial);
        if (liveStable && !isTcpAdbSerial(liveStable)) {
            return liveStable;
        }
    }
    return stableSerial;
}

async function collapseWirelessStateAliases() {
    let changed = false;
    for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
        const canonicalStableSerial = await findCanonicalStableSerialForState(stableSerial, state);
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
    const degradedAdbStatus = {
        reconnecting: 'reconnecting',
        tcpip_unavailable: 'tcpip_unavailable',
        port_closed: 'port_closed',
        different_device: 'different_device',
        unauthorized: 'unauthorized',
    }[supervisorState?.status] || (hasWirelessRoute ? 'offline' : 'unavailable');

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

async function isAgentPackageInstalled(deviceSerial) {
    try {
        const output = await runAdbCapture(['-s', deviceSerial, 'shell', 'pm', 'path', QUEST_AGENT_PACKAGE]);
        return output.includes(`package:`) && output.includes(QUEST_AGENT_PACKAGE);
    } catch (e) {
        return false;
    }
}

async function maybeAutoStartAgent(route, routeHealth) {
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

    const executionSerial = await resolveExecutionSerial(stableSerial) || route?.executionSerial || route?.wirelessSerial || route?.usbSerial;
    if (!executionSerial) {
        return;
    }

    rememberWirelessRoute(stableSerial, { lastAutoStartAttemptAt: Date.now() });
    if (!(await isAgentPackageInstalled(executionSerial))) {
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

async function connectWirelessTarget(stableSerial, force = false) {
    const state = wirelessStateIndex[stableSerial];
    if (state?.ignored) {
        return false;
    }
    const route = deviceRoutingIndex[stableSerial] || {
        stableSerial,
        ip: state?.ip || null,
        wirelessSerial: state?.wirelessSerial || null,
        androidId: state?.androidId || null,
        agentOnline: Boolean(findAgentHeartbeatForRoute({ stableSerial, agentId: state?.agentId, androidId: state?.androidId })),
    };
    const heartbeat = findAgentHeartbeatForRoute(route);
    const recoveryOptions = {
        route,
        heartbeatIp: heartbeat?.local_ip || null,
        force,
        reason: force ? 'explicit_route_repair' : 'discovery_recovery',
    };
    const result = force
        ? await adbSupervisor.forceReconnect(stableSerial, recoveryOptions)
        : await adbSupervisor.tick({ ...route, adbState: 'offline' }, recoveryOptions);
    return result?.status === 'online';
}

async function isAdbRouteOnline(serial) {
    if (!serial) {
        return false;
    }
    try {
        return (await runAdbCapture(['-s', serial, 'get-state'])).trim() === 'device';
    } catch (e) {
        return false;
    }
}

async function getRouteOnlineState(route, cache = new Map()) {
    const readOnline = async (serial) => {
        if (!serial) {
            return false;
        }
        if (!cache.has(serial)) {
            cache.set(serial, await isAdbRouteOnline(serial));
        }
        return Boolean(cache.get(serial));
    };

    return {
        usbOnline: await readOnline(route.usbSerial),
        wirelessOnline: await readOnline(route.wirelessSerial),
    };
}

async function chooseExecutionRoute(route, purpose = 'control', cache = new Map()) {
    const onlineState = await getRouteOnlineState(route, cache);
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

async function resolveLaunchComponentDirect(deviceSerial, packageName) {
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
            const output = (await runAdbCapture(args)).trim();
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

async function getLaunchableApps(serial) {
    const cached = deviceAppCache[serial];
    if (cached && (Date.now() - cached.timestamp) < APP_DISCOVERY_CACHE_MS) {
        return cached.apps;
    }

    try {
        const thirdPartyPackages = new Set(parsePackages(await runAdbCapture(
            ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages', '-3'],
        )));

        const activityQueries = [
            { source: 'launcher', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '--brief'] },
            { source: 'info', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.INFO', '--brief'] },
            { source: 'vr', args: ['-s', serial, 'shell', 'cmd', 'package', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'com.oculus.intent.category.VR', '--brief'] },
        ];

        const launchableApps = new Map();
        for (const query of activityQueries) {
            const output = await runAdbCapture(query.args);
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

            const component = await resolveLaunchComponentDirect(serial, pkg);
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

async function setupWirelessAdb(stableSerial, wifiDetails, options = {}) {
    if (!ENABLE_WIRELESS_ADB || !wifiDetails?.ip) {
        return;
    }

    const state = wirelessStateIndex[stableSerial] || {};
    const usbSerial = options.usbSerial || state.usbSerial || stableSerial;
    const lastSetupAt = Number(state.lastSetupAttemptAt || 0);
    if (!options.force && (Date.now() - lastSetupAt) < WIRELESS_SETUP_RETRY_MS) {
        return;
    }

    rememberWirelessRoute(stableSerial, {
        usbSerial,
        ip: wifiDetails.ip,
        wifiSsid: wifiDetails.wifiSsid ?? null,
        wirelessSerial: toWirelessSerial(wifiDetails.ip),
        lastSetupAttemptAt: Date.now(),
    });

    console.log(`[Wireless ADB] Enabling TCP/IP for ${stableSerial} via ${usbSerial} on ${wifiDetails.ip}:${WIRELESS_ADB_PORT}...`);
    try {
        await runAdbCapture(['-s', usbSerial, 'tcpip', String(WIRELESS_ADB_PORT)]);
    } catch (e) {
        console.warn(`[Wireless ADB] tcpip setup failed for ${stableSerial}: ${e.message}`);
        return;
    }

    await connectWirelessTarget(stableSerial, true);
}

async function refreshDeviceRouting(allowWirelessSetup = true) {
    await collapseWirelessStateAliases();
    const adbDevices = (await listAdbDevicesDetailed()).filter((entry) => ['device', 'unauthorized'].includes(entry.status));
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

        const stableSerial = entry.status === 'device' ? await getDeviceStableSerial(serial) : serial;
        seenStableSerials.add(stableSerial);
        const wifiDetails = entry.status === 'device' ? await getDeviceWifiDetails(serial) : { ip: null, wifiSsid: null };
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
            androidId: entry.status === 'device' ? await getDeviceAndroidId(serial) : state.androidId || null,
            model: entry.status === 'device' ? await getDeviceModel(serial) : state.model || 'Meta Quest',
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

            if (!wirelessByIp.has(wifiDetails.ip) && allowWirelessSetup) {
                void setupWirelessAdb(stableSerial, wifiDetails, { usbSerial: serial });
            }
        } else if (route.wirelessSerial && await isAdbRouteOnline(route.wirelessSerial)) {
            route.executionSerial = route.wirelessSerial;
        }

        routes.set(stableSerial, route);
    }

    for (const entry of adbDevices.filter((item) => item.serial.includes(':') && item.status === 'device')) {
        const ip = entry.serial.split(':')[0];
        const liveStableSerial = await getDeviceStableSerial(entry.serial);
        // A TCP endpoint is only a route. Never bind it to a known Quest by IP
        // when the live identity probe failed; wait for a verified identity.
        const resolvedStableSerial = liveStableSerial && !isTcpAdbSerial(liveStableSerial)
            ? liveStableSerial
            : null;
        if (!resolvedStableSerial) {
            logHub('Routing', 'Ignoring wireless ADB route without verified identity', { route: entry.serial, ip });
            continue;
        }
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
            androidId: await getDeviceAndroidId(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.androidId || null,
            model: await getDeviceModel(entry.serial) || wirelessStateIndex[resolvedStableSerial]?.model || 'Meta Quest',
            hadSuccessfulWifiConnection: true,
        });
    }

    if (ENABLE_WIRELESS_ADB) {
        for (const [stableSerial, state] of Object.entries(wirelessStateIndex)) {
            if (!state?.ip || state?.ignored || routes.has(stableSerial)) {
                continue;
            }
            if (await connectWirelessTarget(stableSerial, false)) {
                justConnectedRoutes.push({
                    stableSerial,
                    ip: state.ip,
                    wirelessSerial: state.wirelessSerial || (state.ip ? toWirelessSerial(state.ip) : null),
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
            wirelessSerial: state.wirelessSerial || (state.ip ? toWirelessSerial(state.ip) : null),
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
        route.executionSerial = await chooseExecutionRoute(route, 'control', onlineStateCache);
        if (route.adbState !== 'unauthorized') {
            route.adbState = route.executionSerial ? 'online' : 'offline';
        }
    }

    deviceRoutingIndex = Object.fromEntries(routes.entries());
    for (const [stableSerial, owner] of scrcpyProcesses.entries()) {
        const nextRoute = deviceRoutingIndex[stableSerial]?.executionSerial;
        if (nextRoute && owner.route && nextRoute !== owner.route) {
            logHub('Cast', 'Stopping scrcpy owned by a stale ADB route', { stableSerial, oldRoute: owner.route, newRoute: nextRoute, errorCode: 'STALE_ROUTE' });
            void terminateOwnedProcess(owner.process, { termGraceMs: CAST_TERM_GRACE_MS, killGraceMs: CAST_KILL_GRACE_MS, log: (scope, message, extra) => logHub(scope, message, extra) })
                .finally(() => { if (scrcpyProcesses.get(stableSerial) === owner) scrcpyProcesses.delete(stableSerial); });
        }
    }
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

async function resolveExecutionSerial(stableSerial) {
    const route = deviceRoutingIndex[stableSerial];
    if (route?.executionSerial && await isAdbRouteOnline(route.executionSerial)) {
        return route.executionSerial;
    }

    await refreshDeviceRouting(false);
    const refreshedRoute = deviceRoutingIndex[stableSerial];
    if (refreshedRoute?.executionSerial && await isAdbRouteOnline(refreshedRoute.executionSerial)) {
        return refreshedRoute.executionSerial;
    }

    if (wirelessStateIndex[stableSerial]?.ip && await connectWirelessTarget(stableSerial, true)) {
        await refreshDeviceRouting(false);
        const reconnectedRoute = deviceRoutingIndex[stableSerial];
        if (reconnectedRoute?.executionSerial && await isAdbRouteOnline(reconnectedRoute.executionSerial)) {
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

async function resolveRouteForCommand(routeKey, commandType, payload = {}) {
    const stableSerial = resolveStableSerial(routeKey);
    const route = deviceRoutingIndex[stableSerial];
    const purpose = prefersUsbForCommand(commandType, payload) ? 'maintenance' : 'control';
    const selectedRoute = route ? await chooseExecutionRoute(route, purpose) : null;
    return {
        stableSerial,
        selectedRoute: selectedRoute || (purpose === 'control' ? await resolveExecutionSerial(stableSerial) : null),
    };
}

async function verifyCommandIdentity(command, executionSerial, stableSerial) {
    if (!executionSerial || !stableSerial) return { matched: false, error: 'DEVICE_IDENTITY_MISMATCH' };
    const expectedStable = String(command.target_stable_id || command.device_serial_number || stableSerial);
    const actualStable = await getDeviceStableSerial(executionSerial);
    if (!actualStable || actualStable !== expectedStable) {
        return { matched: false, error: `ADB route ${executionSerial} is ${actualStable || 'unknown'}, expected ${expectedStable}`, errorCode: 'DEVICE_IDENTITY_MISMATCH' };
    }
    if (command.target_android_id) {
        const actualAndroid = await getDeviceAndroidId(executionSerial);
        if (actualAndroid && actualAndroid !== String(command.target_android_id)) {
            return { matched: false, error: `ADB route android_id ${actualAndroid} does not match command target`, errorCode: 'DEVICE_IDENTITY_MISMATCH' };
        }
    }
    return { matched: true, actualStable };
}

async function getCurrentForegroundPackage(serial) {
    try {
        const output = await runAdbCapture(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
        const matches = [...String(output).matchAll(/(?:mResumedActivity|mFocusedApp|topResumedActivity).*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/g)];
        return matches.at(-1)?.[1] || null;
    } catch (e) {
        return null;
    }
}

async function reconcileCommand(command, executionSerial, stableSerial) {
    const type = String(command.type);
    let payload = command.payload || {};
    try { payload = typeof payload === 'string' ? JSON.parse(payload || '{}') : payload; } catch { return { success: false, unknown: true, error: 'Command payload cannot be parsed during reconciliation', errorCode: 'COMMAND_INTEGRITY_VIOLATION' }; }
    const packageName = payload.package || payload.package_name || payload.current_app_package || null;
    if (['LAUNCH_APP', 'START_SESSION', 'RESUME_SESSION', 'SWITCH_SESSION_APP'].includes(type)) {
        const foreground = await getCurrentForegroundPackage(executionSerial);
        return foreground && packageName && foreground === packageName
            ? { success: true, reconciled: true, message: `Reconciled: ${packageName} is already foreground` }
            : { success: false, unknown: true, error: `Expected ${packageName || 'requested app'} is not foreground`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
    }
    if (type === 'END_SESSION') {
        const foreground = await getCurrentForegroundPackage(executionSerial);
        const heartbeat = findAgentHeartbeatForRoute({ stableSerial });
        return foreground === QUEST_AGENT_PACKAGE && heartbeat && heartbeat.in_session === false && !heartbeat.session_id
            ? { success: true, reconciled: true, cleanup_confirmed: true, foreground_package: foreground, agent_confirmed: true, message: 'Reconciled: launcher foreground and Agent confirmed session cleanup' }
            : { success: false, unknown: true, error: 'Session cleanup could not be confirmed by launcher foreground and Agent signals', errorCode: 'SESSION_CLEANUP_NOT_CONFIRMED' };
    }
    if (type === 'STOP_APP') {
        const foreground = await getCurrentForegroundPackage(executionSerial);
        return !foreground || !packageName || foreground !== packageName
            ? { success: true, reconciled: true, message: 'Reconciled: requested app is no longer foreground' }
            : { success: false, unknown: true, error: `App ${packageName} is still foreground`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
    }
    if (['INSTALL_APP', 'INSTALL_APK'].includes(type)) {
        if (!packageName || !isValidPackage(packageName)) return { success: false, unknown: true, error: 'Cannot reconcile install without a valid package', errorCode: 'COMMAND_RECONCILIATION_FAILED' };
        try {
            const installed = await runAdbCapture(['-s', executionSerial, 'shell', 'pm', 'path', packageName]);
            if (!String(installed).includes('package:')) throw new Error('package is not installed');
            const expectedVersion = payload.version_code == null ? null : String(payload.version_code);
            if (expectedVersion) {
                const details = await runAdbCapture(['-s', executionSerial, 'shell', 'dumpsys', 'package', packageName]);
                if (!new RegExp(`versionCode=${expectedVersion}(?:\\D|$)`).test(String(details))) throw new Error('installed version does not match');
            }
            return { success: true, reconciled: true, message: `Reconciled: ${packageName} is installed` };
        } catch (error) {
            return { success: false, unknown: true, error: error instanceof Error ? error.message : String(error), errorCode: 'COMMAND_RECONCILIATION_FAILED' };
        }
    }
    if (type === 'UNINSTALL_APP') {
        try {
            await runAdbCapture(['-s', executionSerial, 'shell', 'pm', 'path', packageName]);
            return { success: false, unknown: true, error: `${packageName} is still installed`, errorCode: 'COMMAND_RECONCILIATION_FAILED' };
        } catch (e) {
            return { success: true, reconciled: true, message: `Reconciled: ${packageName} is absent` };
        }
    }
    if (type === 'CLOSE_SCRCPY') return { success: true, reconciled: true, message: 'Reconciled: no local scrcpy process remains' };
    return { success: false, unknown: true, error: 'No safe reconciliation probe exists for this command', errorCode: 'COMMAND_RECONCILIATION_FAILED' };
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

async function getScreenrecordDisplayArgs(deviceSerial) {
    if (STREAM_DISPLAY_ID) {
        return ['--display-id', STREAM_DISPLAY_ID];
    }

    try {
        const output = await runAdbCapture(['-s', deviceSerial, 'shell', 'dumpsys', 'SurfaceFlinger', '--display-id']);
        const match = output.match(/Display\s+(\d+)\s+\(HWC display 0\)/);
        return match ? ['--display-id', match[1]] : [];
    } catch (e) {
        console.warn(`[Local Hub] Could not detect display id for screenrecord: ${e.message}`);
        return [];
    }
}

// Safely execute ADB
async function getAdbDevices() {
    return (await refreshDeviceRouting(true))
        .filter((route) => Boolean(route.executionSerial) || route.adbState === 'unauthorized')
        .map((route) => route.stableSerial);
}

function spawnAdb(args, onSuccessMessage) {
    return adbProcessRunner.run(args).then((result) => {
        if (result.ok) return { success: true, message: onSuccessMessage || 'Command executed successfully', stdout: result.stdout };
        const error = result.outputLimitExceeded
            ? 'ADB process output exceeded the configured safety limit.'
            : result.timedOut
            ? `ADB command timed out after ${ADB_COMMAND_TIMEOUT_MS}ms.`
            : result.spawnError?.message || result.stderr || `Process exited with code ${result.code ?? 'unknown'}`;
        logHub('ADB', 'ADB command failed', { args, error, timedOut: result.timedOut, durationMs: result.durationMs });
        return {
            success: false,
            error,
            errorCode: result.outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : result.timedOut ? 'ADB_PROCESS_TIMEOUT' : result.spawnError ? 'ADB_PROCESS_SPAWN_FAILED' : 'ADB_COMMAND_FAILED',
            timedOut: result.timedOut,
            transportFailure: isAdbTransportFailure(result),
        };
    });
}

async function capturePngFrame(deviceSerial) {
    if (!isValidDeviceSerial(deviceSerial)) return { success: false, error: 'Invalid device serial' };
    const result = await adbProcessRunner.run(['-s', deviceSerial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxStdoutBytes: Number(process.env.MAX_SCREENCAP_BYTES || 8 * 1024 * 1024), maxStderrBytes: 256 * 1024 });
    if (result.ok) return { success: true, frame: result.stdout };
    return {
        success: false,
        error: result.outputLimitExceeded ? 'ADB screencap exceeded the binary output safety limit.' : result.timedOut ? `ADB screencap timed out after ${ADB_COMMAND_TIMEOUT_MS}ms.` : result.stderr || `screencap exited with code ${result.code ?? 'unknown'}`,
        errorCode: result.outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : undefined,
        timedOut: result.timedOut,
        transportFailure: isAdbTransportFailure(result),
    };
}

async function legacyStreamDeviceFrames(req, res, deviceSerial, requestedTransport = STREAM_MODE, requestedProfile = STREAM_PROFILE) {
    /* Deprecated pre-manager implementation retained only in source history.
       The active endpoint below uses castManager. */
    return streamDeviceFrames(req, res, deviceSerial, requestedTransport, requestedProfile);
    /*
    const streamRequest = resolveStreamRequest(requestedTransport, requestedProfile);
    if (!streamRequest.ok) {
        safeWriteHead(res, streamRequest.status, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify(streamRequest.body));
    }

    const streamMode = streamRequest.transport;
    const profile = getStreamProfile(streamRequest.profileKey);
    const executionSerial = await resolveExecutionSerial(deviceSerial) || deviceSerial;
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

    const adbArgs = buildAdbScreenrecordArgs(executionSerial, profile, await getScreenrecordDisplayArgs(executionSerial));
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
    */
}

function createScreencapProducer(route) {
    const output = new EventEmitter();
    let timer = null;
    let stopped = false;
    const sendFrame = async () => {
        if (stopped) return;
        const result = await capturePngFrame(route);
        if (stopped) return;
        if (!result.success) {
            const error = new Error(result.error || 'screencap failed');
            error.code = 'STREAM_CAPTURE_FAILED';
            output.emit('error', error);
            return;
        }
        const frame = result.frame;
        output.emit('data', Buffer.concat([
            Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`),
            frame,
            Buffer.from('\r\n'),
        ]));
        timer = setTimeout(sendFrame, STREAM_FRAME_INTERVAL_MS);
    };
    void sendFrame();
    return {
        name: 'screencap-fallback',
        output,
        processes: [],
        detach() { stopped = true; clearTimeout(timer); },
        stop() { stopped = true; clearTimeout(timer); },
    };
}

function createVideoProducer(route, profile, transport, displayArgs) {
    const adbArgs = buildAdbScreenrecordArgs(route, profile, displayArgs);
    const ffmpegArgs = buildFfmpegArgs(transport, profile);
    const adbProc = spawn(ADB_EXECUTABLE, adbArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpegProc = spawn(FFMPEG_EXECUTABLE, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (adbProc.stdout && ffmpegProc.stdin) adbProc.stdout.pipe(ffmpegProc.stdin);
    const appendDiagnostic = (name, chunk) => logHub('Cast', `${name} diagnostic`, {
        route,
        transport,
        profile: profile.key,
        stderr: String(chunk).slice(-2048),
    });
    adbProc.stderr?.on('data', (chunk) => appendDiagnostic('adb screenrecord', chunk));
    ffmpegProc.stderr?.on('data', (chunk) => appendDiagnostic('ffmpeg', chunk));
    ffmpegProc.stdin?.on('error', (error) => logHub('Cast', 'ffmpeg stdin closed', { route, message: error.message, errorCode: 'CAST_PIPE_BROKEN' }));
    return {
        name: 'adb-screenrecord+ffmpeg',
        output: ffmpegProc.stdout,
        processes: [adbProc, ffmpegProc],
        detach() {
            adbProc.stdout?.unpipe?.(ffmpegProc.stdin);
            ffmpegProc.stdin?.destroy?.();
        },
        adbArgs,
        ffmpegArgs,
    };
}

async function streamDeviceFrames(req, res, deviceSerial, requestedTransport = STREAM_MODE, requestedProfile = STREAM_PROFILE) {
    const streamRequest = resolveStreamRequest(requestedTransport, requestedProfile);
    if (!streamRequest.ok) {
        safeWriteHead(res, streamRequest.status, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify(streamRequest.body));
    }
    const streamMode = streamRequest.transport;
    const profile = getStreamProfile(streamRequest.profileKey);
    const stableSerial = resolveStableSerial(deviceSerial);
    const executionSerial = await resolveExecutionSerial(stableSerial) || deviceSerial;
    if (!isValidDeviceSerial(executionSerial)) {
        safeWriteHead(res, 409, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify({ error: 'DEVICE_ROUTE_UNAVAILABLE', next_step: 'Reconnect ADB and retry the cast.' }));
    }
    const displayArgs = streamMode === 'screencap' ? [] : await getScreenrecordDisplayArgs(executionSerial);
    const responseHeaders = streamMode === 'screencap'
        ? { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Connection: 'close', 'X-BizonVR-Cast-Transport': 'screencap' }
        : { 'Content-Type': streamMode === 'fmp4' ? 'video/mp4' : 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Accept-Ranges': 'none', Connection: 'close', 'X-BizonVR-Cast-Transport': streamMode, 'X-BizonVR-Cast-Profile': profile.key };
    const fallbackResponseHeaders = { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Connection: 'close', 'X-BizonVR-Cast-Transport': 'screencap', 'X-BizonVR-Cast-Profile': profile.key };
    wakeDeviceForCast(executionSerial);
    if (scrcpyProcesses.has(stableSerial)) {
        safeWriteHead(res, 409, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify({
            error: 'SCRCPY_ALREADY_ACTIVE',
            message: 'A managed scrcpy window already owns this Quest capture route.',
            next_step: 'Close the scrcpy session before opening browser cast.',
        }));
    }
    const primary = ({ record }) => createVideoProducer(record.route, profile, streamMode, record.route === executionSerial ? displayArgs : []);
    const fallback = ({ record }) => {
        screencapFallbackCount += 1;
        logHub('Cast', 'Starting screencap fallback', { castId: record.castId, stableSerial, route: record.route, fallback_count: screencapFallbackCount, diagnostic: 'fallback_started' });
        return createScreencapProducer(record.route);
    };
    const result = castManager.attachViewer({
        key: stableSerial,
        route: executionSerial,
        transport: streamMode,
        profile: profile.key,
        responseHeaders,
        fallbackResponseHeaders,
        req,
        res,
        startProducer: streamMode === 'screencap' ? fallback : primary,
        fallbackProducer: streamMode === 'screencap' ? null : fallback,
    });
    if (!result.ok) {
        safeWriteHead(res, result.status, { 'Content-Type': 'application/json' });
        return safeEnd(res, JSON.stringify(result.body));
    }
    logHub('Cast', 'Viewer attached to cast producer', { castId: result.record.castId, generation: result.record.generation, stableSerial, route: executionSerial, transport: streamMode, profile: profile.key, viewerCount: result.record.viewers.size });
}

async function startAppComponent(deviceSerial, component) {
    if (!component) {
        return { success: true, message: 'No explicit activity provided' };
    }
    logHub('ADB', `Launching component ${component} on ${deviceSerial}`);
    return spawnAdb(['-s', deviceSerial, 'shell', 'am', 'start', '-n', component], `Started ${component}`);
}

async function startAndVerifyApp(deviceSerial, component, expectedPackage) {
    const launch = await startAppComponent(deviceSerial, component);
    if (!launch.success) return launch;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const foreground = await getCurrentForegroundPackage(deviceSerial);
        if (foreground === expectedPackage) {
            return { ...launch, foreground_package: foreground, launch_verified: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return {
        success: false,
        error: `App launch was not verified: expected ${expectedPackage}, foreground is different`,
        errorCode: 'APP_LAUNCH_NOT_CONFIRMED',
        launch_verified: false,
    };
}

async function resolveLaunchComponent(deviceSerial, packageName) {
    if (!packageName) {
        return null;
    }

    try {
        const knownApps = await getLaunchableApps(deviceSerial);
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
    // The reverse tunnel is an optional optimization. Do not block intent
    // construction or the hub event loop on it; the Agent always receives the
    // real LAN callback target.
    void prepareAgentConnection(deviceSerial);
    const connection = { host: HUB_HOST, port: Number(LOCAL_SERVER_PORT) };
    const args = [
        '-s', deviceSerial,
        'shell', 'am', 'start',
        '-a', 'android.intent.action.MAIN',
        '-c', 'com.oculus.intent.category.VR',
        '-n', buildAgentComponent(),
        '--es', 'HUB_IP', connection.host,
        '--ei', 'HUB_PORT', connection.port,
    ];
    const stableSerial = resolveStableSerial(deviceSerial);
    const agentToken = options.agentToken || agentCredentials[stableSerial]?.token;
    if (agentToken) args.push('--es', 'AGENT_TOKEN', String(agentToken));

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
        if (state.revision !== undefined && state.revision !== null) {
            args.push('--el', 'SESSION_REVISION', Number(state.revision));
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

async function prepareAgentConnection(deviceSerial) {
    if (isLoopbackHost(HUB_HOST)) {
        throw new Error('Refusing to pass loopback HUB_HOST to Quest Agent. Set HUB_HOST to a LAN IP reachable from the headset.');
    }
    try {
        await runAdb(['-s', deviceSerial, 'reverse', `tcp:${LOCAL_SERVER_PORT}`, `tcp:${LOCAL_SERVER_PORT}`]);
        logHub('ADB', `Reverse tunnel active for ${deviceSerial} on tcp:${LOCAL_SERVER_PORT}; using LAN callback ${HUB_HOST}:${LOCAL_SERVER_PORT}`);
        return { host: HUB_HOST, port: Number(LOCAL_SERVER_PORT) };
    } catch (e) {
        logHub('ADB', `Reverse tunnel unavailable for ${deviceSerial}, falling back to hub host ${HUB_HOST}:${LOCAL_SERVER_PORT}`);
        return { host: HUB_HOST, port: Number(LOCAL_SERVER_PORT) };
    }
}

async function wakeDevice(deviceSerial) {
    const executionSerial = await resolveExecutionSerial(deviceSerial) || deviceSerial;
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

async function runCommand(deviceSerial, commandType, payloadStr, commandMeta = {}) {
  let payload = {};
  try { payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr || '{}') : (payloadStr || {}); } catch (e) {}
  const stableSerial = resolveStableSerial(deviceSerial);
  if (['RECONNECT_ADB', 'FORGET_DEVICE', 'RUN_DIAGNOSTICS'].includes(commandType)) {
      return runCommandOnce(deviceSerial, commandType, payloadStr, commandMeta);
  }
  const result = await executeWithAdbRecovery({
      stableSerial,
      commandType,
      resolveRoute: async (stable) => {
          const resolved = await resolveRouteForCommand(stable, commandType, payload);
          return resolved.selectedRoute;
      },
      healthCheck: (route) => isAdbRouteOnline(route),
      execute: () => runCommandOnce(deviceSerial, commandType, payloadStr, commandMeta),
      recover: async (stable, context) => {
          const state = await adbSupervisor.forceReconnect(stable, {
              route: deviceRoutingIndex[stable],
              heartbeatIp: findAgentHeartbeatForRoute(deviceRoutingIndex[stable] || {})?.local_ip || null,
              reason: 'command_transport_failure',
              failedRoute: context.failedRoute,
          });
          if (state?.status !== 'online') return false;
          await refreshDeviceRouting(false);
          return true;
      },
      retryable: isSafeAdbRetry(commandType),
      onEvent: (event) => logHub('ADB', 'ADB command recovery event', event),
  });
  const previousMetrics = adbCommandMetricsByStableSerial.get(stableSerial) || { commandTimeout: 0, lastSuccessfulCommand: null };
  adbCommandMetricsByStableSerial.set(stableSerial, {
      ...previousMetrics,
      commandTimeout: previousMetrics.commandTimeout + (result?.timedOut ? 1 : 0),
      lastSuccessfulCommand: result?.success ? { type: commandType, at: Date.now() } : previousMetrics.lastSuccessfulCommand,
  });
  return result;
}

function runCommandOnce(deviceSerial, commandType, payloadStr, commandMeta = {}) {
  return new Promise(async (resolve) => {
     let logPayload = {};
     try { logPayload = JSON.parse(payloadStr || '{}'); } catch (e) {}
     const safeLogPayload = Object.fromEntries(Object.entries(logPayload).map(([key, value]) => [/token|secret|credential/i.test(key) ? [key, '[REDACTED]'] : [key, value]]));
     logHub('Command', `Executing ${commandType} on ${deviceSerial}`, safeLogPayload);
     
     let payload = {};
     try { payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr || '{}') : (payloadStr || {}); } catch(e) {}
     const { stableSerial, selectedRoute } = await resolveRouteForCommand(deviceSerial, commandType, payload);
     rememberAgentCredential(stableSerial, payload);
     const adbRoute = selectedRoute;

     if (!['RECONNECT_ADB', 'FORGET_DEVICE', 'RUN_DIAGNOSTICS'].includes(commandType) && !adbRoute) {
        return resolve({ success: false, error: `No stable ADB route is available for ${stableSerial}`, errorCode: 'DEVICE_UNAVAILABLE' });
     }
     if (adbRoute && commandMeta.id) {
        const identity = await verifyCommandIdentity(commandMeta, adbRoute, stableSerial);
        if (!identity.matched) {
            logHub('Command', `Refusing command ${commandMeta.id} on an unverified route`, { stableSerial, route: adbRoute, error: identity.error });
            return resolve({ success: false, error: identity.error, errorCode: identity.errorCode || 'DEVICE_IDENTITY_MISMATCH', identityMismatch: true });
        }
     }

     if (commandType === 'OPEN_SCRCPY') {
        if (activeCastStreams.has(stableSerial)) {
             return resolve({ success: false, error: 'Browser cast already owns the Quest capture pipeline', errorCode: 'CAST_ALREADY_ACTIVE' });
        }
        if (scrcpyProcesses.has(stableSerial)) {
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
        const scrcpy = spawn(SCRCPY_EXECUTABLE, scrcpyArgs);
        let settled = false;
        scrcpyProcesses.set(stableSerial, { process: scrcpy, route: adbRoute, startedAt: Date.now() });
        scrcpy.on('error', (err) => {
           console.log(`[scrcpy error] ${err.message}`);
           if (scrcpyProcesses.get(stableSerial)?.process === scrcpy) scrcpyProcesses.delete(stableSerial);
           if (!settled) {
               settled = true;
               resolve({ success: false, error: `scrcpy could not start: ${err.message}`, errorCode: err.code === 'ENOENT' ? 'SCRCPY_NOT_FOUND' : 'SCRCPY_START_FAILED' });
           }
        });
        scrcpy.on('spawn', () => {
           if (!settled) {
               settled = true;
               resolve({ success: true, message: "scrcpy spawned" });
           }
        });
        scrcpy.on('close', (code, signal) => {
           if (scrcpyProcesses.get(stableSerial)?.process === scrcpy) scrcpyProcesses.delete(stableSerial);
           if (code !== 0 && !settled) {
               settled = true;
               resolve({ success: false, error: `scrcpy exited before becoming usable${signal ? ` (${signal})` : ''}`, errorCode: 'SCRCPY_PROCESS_EXIT' });
           }
        });

     } else if (commandType === 'CLOSE_SCRCPY') {
        const ownedScrcpy = scrcpyProcesses.get(stableSerial);
        if (ownedScrcpy?.process) {
             void terminateOwnedProcess(ownedScrcpy.process, { termGraceMs: CAST_TERM_GRACE_MS, killGraceMs: CAST_KILL_GRACE_MS, log: (scope, message, extra) => logHub(scope, message, extra) })
               .finally(() => {
                   if (scrcpyProcesses.get(stableSerial)?.process === ownedScrcpy.process) scrcpyProcesses.delete(stableSerial);
                   resolve({ success: true, message: "scrcpy closed" });
               });
        } else {
             resolve({ success: true, message: "scrcpy not running" });
        }

     } else if (commandType === 'START_SESSION') {
        const pkg = payload.package || QUEST_AGENT_PACKAGE;
        const activity = payload.activity || await resolveLaunchComponent(deviceSerial, pkg);
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
                    const launchRes = await startAndVerifyApp(adbRoute, activity, pkg);
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

        const stop = await spawnAdb(['-s', adbRoute, 'shell', 'am', 'force-stop', pkg], 'Package force-stopped');
        if (!stop.success) return resolve(stop);
        finishWithLauncher();

     } else if (commandType === 'RESUME_SESSION') {
        const pkg = payload.current_app_package || payload.package || QUEST_AGENT_PACKAGE;
        if (payload.resync_only) {
            return spawnAdb(buildAgentStartArgs(adbRoute, {
                action: 'SYNC',
                pkg,
                sessionState: payload.session_state || null,
                autoLaunch: false,
            }), 'Agent synchronized session state').then(resolve);
        }
        const activity = payload.activity || await resolveLaunchComponent(deviceSerial, pkg);
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
                const launchRes = await startAndVerifyApp(adbRoute, activity, pkg);
                resolve(launchRes.success ? res : launchRes);
            });

     } else if (commandType === 'EXTEND_SESSION') {
        const pkg = payload.package || payload.current_app_package;
        logHub('Session', `Synchronizing extended session on ${adbRoute}`, { pkg });
        return spawnAdb(buildAgentStartArgs(adbRoute, {
            action: 'SYNC',
            pkg,
            sessionState: payload.session_state || null,
            autoLaunch: false,
        }), 'Agent synchronized extended session').then(resolve);

     } else if (commandType === 'SWITCH_SESSION_APP') {
        const pkg = payload.package || payload.current_app_package;
        const activity = payload.activity || await resolveLaunchComponent(deviceSerial, pkg);
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
                const launchRes = await startAndVerifyApp(adbRoute, activity, pkg);
                resolve(launchRes.success ? res : launchRes);
            });

     } else if (commandType === 'END_SESSION') {
        const pkg = payload.package;
        if (!isValidPackage(pkg)) return resolve({ success: false, error: "Invalid package name" });
        
        logHub('Session', `Stopping package ${pkg} on ${adbRoute}`);
        
        const stop = await spawnAdb(['-s', adbRoute, 'shell', 'am', 'force-stop', pkg], 'Package force-stopped');
        if (!stop.success) return resolve(stop);
        // Wait a second then launch the club launcher setting the intent action to stop.
        setTimeout(() => {
            spawnAdb(buildAgentStartArgs(adbRoute, {
                action: 'STOP',
                sessionState: payload.session_state || null,
                autoLaunch: false,
            }), "Session ended, launcher started").then(async (result) => {
                if (!result.success) return resolve(result);
                const deadline = Date.now() + Number(process.env.SESSION_CLEANUP_CONFIRM_TIMEOUT_MS || 5000);
                while (Date.now() < deadline) {
                    const foreground = await getCurrentForegroundPackage(adbRoute);
                    const heartbeat = findAgentHeartbeatForRoute({ stableSerial });
                    if (foreground === QUEST_AGENT_PACKAGE && heartbeat && heartbeat.in_session === false && !heartbeat.session_id) {
                        return resolve({ ...result, cleanup_confirmed: true, foreground_package: foreground, agent_confirmed: true });
                    }
                    await delay(200);
                }
                resolve({ success: false, error: 'Session cleanup could not be confirmed by foreground and Agent signals', errorCode: 'SESSION_CLEANUP_NOT_CONFIRMED', operator_required: true });
            });
        }, 1000);

     } else if (commandType === 'INSTALL_APP') {
        const artifact = resolveApprovedApk(payload, { root: APK_ARTIFACT_ROOT, sha256File });
        if (artifact.error) return resolve({ success: false, error: artifact.error, errorCode: artifact.errorCode || 'APK_VALIDATION_FAILED' });
        logHub('ADB', `Installing approved APK artifact on ${adbRoute}`);
        spawnAdb(['-s', adbRoute, 'install', '-r', artifact.path], "APK Installed")
            .then(resolve);

     } else if (commandType === 'INSTALL_APK') {
        const agentPkg = payload.package_name || QUEST_AGENT_PACKAGE;
        if (!isValidPackage(agentPkg)) return resolve({ success: false, error: "Invalid package name" });
        if (!payload.apk_checksum) return resolve({ success: false, error: "Missing APK checksum in command payload" });
        const artifact = resolveApprovedApk({ ...payload, artifact_id: payload.artifact_id || path.basename(QUEST_AGENT_APK_PATH) }, { root: APK_ARTIFACT_ROOT, sha256File });
        if (artifact.error) return resolve({ success: false, error: artifact.error, errorCode: artifact.errorCode || 'APK_VALIDATION_FAILED' });
        rememberAgentCredential(stableSerial, payload);
        logHub('Agent', `Installing Quest Agent on ${adbRoute}`);
        spawnAdb(['-s', adbRoute, 'install', '-r', artifact.path], `Installed Agent`)
            .then((res) => {
                if(res.success) {
                    logHub('Agent', `Starting Quest Agent on ${adbRoute}`);
                    spawnAdb(buildAgentStartArgs(adbRoute, { agentToken: payload.agent_token }), `Started Agent installed`)
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
                const stableSerial = payload.stable_serial || await getDeviceStableSerial(usbSerial);
                const wifiDetails = await getDeviceWifiDetails(usbSerial);
                rememberWirelessRoute(stableSerial, {
                    usbSerial,
                    ip: wifiDetails.ip,
                    wifiSsid: wifiDetails.wifiSsid ?? null,
                    androidId: await getDeviceAndroidId(usbSerial),
                    model: await getDeviceModel(usbSerial),
                    knownDevice: true,
                });
                void setupWirelessAdb(stableSerial, wifiDetails, { force: true, usbSerial }).catch((error) => {
                    logHub('Wireless ADB', 'USB repair failed during async setup', { stableSerial, error: error instanceof Error ? error.message : String(error) });
                });
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
        await refreshDeviceRouting(false);
        resolve(reconnectState?.status === 'online'
            ? { success: true, message: "ADB reconnect attempted using remembered Wi-Fi routes" }
            : { success: false, error: reconnectState?.lastError || "No remembered Wi-Fi route could be reconnected. Connect USB and run Repair via USB." });

     } else if (commandType === 'RELAUNCH_AGENT') {
        const executionSerial = await resolveExecutionSerial(stableSerial) || adbRoute;
        if (!isValidDeviceSerial(executionSerial)) {
            return resolve({ success: false, error: "No valid ADB route is available to relaunch Quest Agent" });
        }
        spawnAdb(buildAgentStartArgs(executionSerial), "Quest Agent relaunched")
            .then(resolve);

     } else if (commandType === 'RUN_DIAGNOSTICS') {
        await refreshDeviceRouting(false);
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
        adbSupervisor.forget?.(stableSerial);
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
            headers: {
                ...(HUB_TOKEN ? { Authorization: `Bearer ${HUB_TOKEN}` } : {}),
                'x-hub-id': String(HUB_ID),
            },
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

let syncInFlight = false;

function sendStatusRequest(cmdId, status, body = {}) {
    return new Promise((resolve) => {
        const protocol = API_URL.startsWith('https') ? https : http;
        const data = JSON.stringify({ status, ...body, hub_id: HUB_ID, hub_instance_id: HUB_INSTANCE_ID });
        const req = protocol.request(`${API_URL}/api/commands/${cmdId}/status`, {
            method: 'POST', timeout: BOOTSTRAP_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(HUB_TOKEN ? { Authorization: `Bearer ${HUB_TOKEN}` } : {}) },
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        });
        req.on('timeout', () => req.destroy(new Error('Cloud status request timeout')));
        req.on('error', (error) => { logHub('ResultDelivery', `Cloud status request failed for command ${cmdId}`, { error: error.message, status }); resolve(false); });
        req.end(data);
    });
}

async function flushResultOutbox() {
    executionStore.resetExhaustedOutbox();
    for (const item of executionStore.pendingOutbox(100)) {
        const deliveryAttempt = Number(item.attempt || 0) + 1;
        const result = JSON.parse(item.result_json || '{}');
        const ok = await sendStatusRequest(item.command_id, item.status, {
            claim_token: item.claim_token,
            result,
            error_message: result.error,
            error_code: result.error_code,
            outcome_state: item.status === 'timeout' ? 'unknown' : 'known',
            result_delivery_attempt: deliveryAttempt,
        });
        if (ok) executionStore.markOutboxDelivered(item.command_id);
        else if (deliveryAttempt <= 8) {
            executionStore.markOutboxAttempt(item.command_id, 'Cloud unavailable or rejected result', Math.min(60000, 1000 * (2 ** Math.min(deliveryAttempt, 6))));
            if (deliveryAttempt === 8) logHub('ResultDelivery', 'Terminal result retained durably after bounded delivery burst', { commandId: item.command_id, resultDeliveryAttempt: deliveryAttempt, errorCode: 'CLOUD_RESULT_DELIVERY_FAILED' });
        }
        else logHub('ResultDelivery', 'Terminal result remains pending after bounded delivery attempts', { commandId: item.command_id, resultDeliveryAttempt: deliveryAttempt, errorCode: 'CLOUD_RESULT_DELIVERY_FAILED' });
    }
    executionStore.prune();
}

async function reportCommandStatus(cmd, status, result = {}, options = {}) {
    const body = {
        error_message: result?.error,
        error_code: result?.errorCode || options.errorCode,
        outcome_state: options.outcomeState || (status === 'succeeded' ? 'known' : status === 'timeout' ? 'unknown' : 'known'),
        reconciled: Boolean(result?.reconciled || options.reconciled),
        route: options.route || null,
        result,
        claim_token: cmd?.claim_token || options.claimToken || null,
    };
    if (['succeeded', 'failed', 'timeout', 'cancelled'].includes(status)) {
        executionStore.enqueue(cmd.id, status, result, { claimToken: cmd?.claim_token });
        return flushResultOutbox();
    }
    await sendStatusRequest(cmd.id, status, body);
}

async function syncWithCloud() {
   if (syncInFlight) return;
   syncInFlight = true;
   const protocol = API_URL.startsWith('https') ? https : http;
   const activeSerials = await getAdbDevices();
   const deviceRoutes = Object.values(deviceRoutingIndex);
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
       void maybeAutoStartAgent(route, routeHealth);
       let battery = 85;
       let installedApps = [];
       if (executionSerial && executionSerial !== '1G0YK01234' && routeHealth.adb_status === 'online') {
           try {
               const batteryOut = await runAdbCapture(['-s', executionSerial, 'shell', 'dumpsys', 'battery']);
               const match = batteryOut.match(/level:\s*(\d+)/);
               if (match) battery = parseInt(match[1], 10);
           } catch(e) {
               console.warn(`[WARN] ADB dumpsys failed for ${executionSerial}`);
           }
           installedApps = await getLaunchableApps(executionSerial);
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
           adb_metrics: adbSupervisor.getMetrics(route.stableSerial),
           adb_last_reconnect: adbSupervisor.getState(route.stableSerial)?.lastReconnect || null,
           adb_command_metrics: adbCommandMetricsByStableSerial.get(route.stableSerial) || null,
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
       hub_instance_id: HUB_INSTANCE_ID,
   });

   const req = protocol.request(`${API_URL}/api/hubs/${HUB_ID}/sync`, {
      method: 'POST',
      timeout: BOOTSTRAP_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestData),
        ...(HUB_TOKEN ? { Authorization: `Bearer ${HUB_TOKEN}` } : {}),
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
            
            await flushResultOutbox();
            await Promise.all(commands.map(async (cmd) => {
               logHub('Command', `Received command ${cmd.type}#${cmd.id} for device ${cmd.device_id}`);

               const journal = cmd.recovery_required ? executionStore.recoverAfterRestart(cmd) : executionStore.claim(cmd);
               if (journal.kind === 'integrity_violation') {
                   await reportCommandStatus(cmd, 'failed', { success: false, error: 'Command payload or target identity changed for an existing command id', errorCode: 'COMMAND_INTEGRITY_VIOLATION' }, { errorCode: 'COMMAND_INTEGRITY_VIOLATION' });
                   return;
               }
               if (['already_done', 'in_flight', 'cancelled'].includes(journal.kind)) return;

               const targetStableSerial = typeof cmd.device_serial_number === 'string'
                   ? cmd.device_serial_number
                   : selectExecutionSerial(activeSerials);
                   const executionSerial = targetStableSerial ? await resolveExecutionSerial(targetStableSerial) : null;
               logHub('Routing', `Resolved command route for ${cmd.type}#${cmd.id}`, {
                   targetStableSerial,
                   executionSerial,
               });

               const canRunWithoutCurrentRoute = ['RECONNECT_ADB', 'FORGET_DEVICE'].includes(String(cmd.type));
               if (journal.kind === 'reconciliation_required' || journal.kind === 'unknown_outcome') {
                   const reconciliation = executionSerial && journal.policy?.reconciliable
                       ? await reconcileCommand(cmd, executionSerial, targetStableSerial)
                       : { success: false, unknown: true, error: 'Side effect may have happened before Local Hub restart; no safe blind retry is allowed', errorCode: 'COMMAND_OUTCOME_UNKNOWN' };
                   if (reconciliation.success) {
                       executionStore.complete(cmd.id, reconciliation, { claimToken: cmd.claim_token });
                       await reportCommandStatus(cmd, 'succeeded', reconciliation, { reconciled: true, route: executionSerial });
                   } else {
                       executionStore.markUnknown(cmd.id, reconciliation.error, { errorCode: reconciliation.errorCode || 'COMMAND_RECONCILIATION_FAILED' });
                       await reportCommandStatus(cmd, 'timeout', { success: false, error: reconciliation.error, errorCode: reconciliation.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }, { outcomeState: 'unknown', errorCode: reconciliation.errorCode || 'COMMAND_OUTCOME_UNKNOWN' });
                   }
                   return;
               }
               if (!executionSerial && !canRunWithoutCurrentRoute) {
                   const result = { success: false, error: 'Device is unreachable over USB/Wi-Fi ADB. Reconnect the headset or re-enable wireless debugging.', errorCode: 'DEVICE_UNAVAILABLE' };
                   executionStore.fail(cmd.id, result.error, { errorCode: result.errorCode, claimToken: cmd.claim_token });
                   await reportCommandStatus(cmd, 'failed', result, { errorCode: result.errorCode });
                   return;
               }

               await reportCommandStatus(cmd, 'running', { state: 'running' }, { route: executionSerial });
               const commandRoute = executionSerial || targetStableSerial;
               const result = await runWithDeviceLock(targetStableSerial || commandRoute, () => runCommand(commandRoute, cmd.type, cmd.payload, cmd));
               logHub('Command', `Finished ${cmd.type}#${cmd.id} on ${commandRoute}`, result);
               if (result.success) {
                   executionStore.markEffectApplied(cmd.id, result);
                   executionStore.complete(cmd.id, result, { claimToken: cmd.claim_token });
                   await reportCommandStatus(cmd, 'succeeded', result, { route: commandRoute });
               } else if (result.unknown || (getCommandPolicy(cmd.type).dangerous && (result.timedOut || result.transportFailure))) {
                   executionStore.markUnknown(cmd.id, result.error, { errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN' });
                   await reportCommandStatus(cmd, 'timeout', { success: false, error: result.error || 'Command outcome is unknown', errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN' }, { outcomeState: 'unknown', errorCode: result.errorCode || 'COMMAND_OUTCOME_UNKNOWN', route: commandRoute });
               } else {
                   const failure = { success: false, error: result.error || 'Command failed', errorCode: result.errorCode || 'COMMAND_EXECUTION_FAILED' };
                   executionStore.fail(cmd.id, failure.error, { errorCode: failure.errorCode, claimToken: cmd.claim_token });
                   await reportCommandStatus(cmd, 'failed', failure, { errorCode: failure.errorCode, route: commandRoute });
               }
            }));
         } catch(e) {
            console.error('Failed to parse sync response', e.message);
         } finally {
            syncInFlight = false;
         }
      });
   });
   
   req.on('error', (e) => {
      console.error('Local Hub sync error:', e.message);
      syncInFlight = false;
   });
   req.on('timeout', () => req.destroy(new Error('Cloud sync request timeout')));
   
   req.write(requestData);
   req.end();
   // Response processing resets the guard after all commands have been handled.
}

// --- Local Hub Mini-Server ---
const localServer = http.createServer((req, res) => {
    // CORS headers for local network just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
        readJsonBody(req, AGENT_JSON_BODY_LIMIT).then((data) => {
            try {
                const auth = verifyAgentRequest(req, data);
                if (!auth.ok) {
                    res.writeHead(auth.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: auth.status === 408 ? 'STALE_HEARTBEAT' : auth.status === 409 ? 'REPLAYED_HEARTBEAT' : 'Invalid Agent credentials' }));
                }
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
                if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        }).catch((error) => {
            res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.statusCode === 413 ? 'Request body is too large' : 'Malformed JSON body' }));
        });
    } else if (req.method === 'POST' && req.url === '/api/agent/call_operator') {
        readJsonBody(req, AGENT_JSON_BODY_LIMIT).then((data) => {
            try {
                const auth = verifyAgentRequest(req, data);
                if (!auth.ok) {
                    res.writeHead(auth.status, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid Agent credentials' }));
                }
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
                cloudReq.write(JSON.stringify({ pairing_id: data.pairing_id, hub_id: HUB_ID }));
                cloudReq.end();
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Request' }));
            }
        }).catch((error) => {
            res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.statusCode === 413 ? 'Request body is too large' : 'Malformed JSON body' }));
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

localServer.on('error', (err) => {
    console.error(`[Local Hub Mini-Server] Failed to start on port ${LOCAL_SERVER_PORT}: ${err.message}`);
});

let syncPollTimer = null;
let shutdownPromise = null;
async function shutdownLocalHub(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        logHub('Hub', 'Graceful shutdown requested', { signal, activeCasts: castManager.getActiveCount(), activeScrcpy: scrcpyProcesses.size });
        await castManager.stopAll('hub_shutdown');
        await Promise.all([...scrcpyProcesses.values()].map(async ({ process }) => {
            try { process.kill('SIGTERM'); } catch {}
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, CAST_KILL_GRACE_MS);
                process.once?.('close', () => { clearTimeout(timer); resolve(); });
            });
            if (process.exitCode == null) {
                try { process.kill('SIGKILL'); } catch {}
            }
        }));
        scrcpyProcesses.clear();
        if (syncPollTimer) clearInterval(syncPollTimer);
        await Promise.race([
            new Promise((resolve) => {
                try { localServer.close(() => resolve()); } catch { resolve(); }
            }),
            new Promise((resolve) => setTimeout(resolve, CAST_TERM_GRACE_MS + CAST_KILL_GRACE_MS + 2000)),
        ]);
        logHub('Hub', 'Graceful shutdown complete', { signal });
    })();
    return shutdownPromise;
}

process.once('SIGTERM', () => { void shutdownLocalHub('SIGTERM').finally(() => { process.exitCode = 0; }); });
process.once('SIGINT', () => { void shutdownLocalHub('SIGINT').finally(() => { process.exitCode = 0; }); });

localServer.listen(LOCAL_SERVER_PORT, '0.0.0.0', () => {
    console.log(`[Local Hub Mini-Server] Listening for Agent heartbeats on port ${LOCAL_SERVER_PORT}`);

    // Start polling only after the local callback server is ready so Agent reverse
    // tunnels and heartbeat posts have a live target immediately.
    bootstrapKnownDevices().finally(() => {
        syncPollTimer = setInterval(syncWithCloud, POLL_INTERVAL_MS);
        syncWithCloud();
    });
});
