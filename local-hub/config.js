import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CAST_PROFILE, DEFAULT_CAST_TRANSPORT } from '../src/shared/cast-config.js';

function readNumber(env, fallback, minimum = 0) {
    const value = Number(process.env[env]);
    return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function isLoopbackHost(host) {
    return ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());
}

function getPreferredHostIp() {
    const interfaces = os.networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
        for (const address of addresses || []) {
            if (address?.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return '127.0.0.1';
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

function resolveQuestAgentApkPath(apkArtifactRoot) {
    const explicitPath = process.env.QUEST_AGENT_APK_PATH;
    if (explicitPath) return path.resolve(explicitPath);
    const candidate = path.join(apkArtifactRoot, 'quest-agent.apk');
    try {
        fs.accessSync(candidate);
        return candidate;
    } catch {
        return candidate;
    }
}

export function loadConfig() {
    const hubId = Number(process.env.HUB_ID || 1);
    const apiUrl = process.env.APP_URL || 'http://localhost:3000';
    const localServerPort = process.env.HUB_PORT || 3001;
    const apkArtifactRoot = path.resolve(process.env.APK_CACHE_ROOT || path.join(process.cwd(), '.cache', 'local-hub', 'apks'));
    const hubToken = process.env.HUB_TOKEN || (() => {
        try { return JSON.parse(process.env.HUB_TOKENS_JSON || '{}')[String(hubId)] || ''; } catch { return ''; }
    })();

    const config = {
        HUB_ID: hubId,
        API_URL: apiUrl,
        POLL_INTERVAL_MS: 5000,
        LOCAL_SERVER_PORT: localServerPort,
        HUB_HOST: resolveHubHost(),
        HUB_TOKEN: hubToken,
        QUEST_AGENT_PACKAGE: process.env.QUEST_AGENT_PACKAGE || 'com.bizonvr.spatialspike',
        QUEST_AGENT_MAIN_ACTIVITY: process.env.QUEST_AGENT_MAIN_ACTIVITY || '.SpatialLauncherActivity',
        APK_ARTIFACT_ROOT: apkArtifactRoot,
        QUEST_AGENT_APK_PATH: resolveQuestAgentApkPath(apkArtifactRoot),
        ENABLE_WIRELESS_ADB: process.env.ENABLE_WIRELESS_ADB === '1',
        SCRCPY_MAX_SIZE: process.env.SCRCPY_MAX_SIZE || '1600',
        SCRCPY_BITRATE: process.env.SCRCPY_BITRATE || '25M',
        SCRCPY_CROP: process.env.SCRCPY_CROP || '',
        APP_DISCOVERY_CACHE_MS: 60000,
        EXCLUDED_APP_PREFIXES: ['com.oculus.', 'com.meta.', 'com.android.', 'su.happ.'],
        EXCLUDED_APP_PACKAGES: new Set([
            'com.oculus.accountscenter',
            'com.oculus.igvr',
            'com.oculus.vrprivacycheckup',
            'com.meta.handseducationmodule',
            'su.happ.proxyutility',
            'com.whatsapp',
        ]),
        INCLUDED_NON_VR_PACKAGES: new Set([
            'com.bigscreenvr.bigscreen',
            'com.google.android.apps.youtube.vr.oculus',
            'com.activ8.kizunaaivr',
        ]),
        STREAM_FRAME_INTERVAL_MS: Number(process.env.STREAM_FRAME_INTERVAL_MS || 120),
        DEVICE_SERIAL_REGEX: /^[A-Za-z0-9._:-]+$/,
        STREAM_BOOT_TIMEOUT_MS: Number(process.env.STREAM_BOOT_TIMEOUT_MS || 7000),
        AGENT_JSON_BODY_LIMIT: readNumber('AGENT_JSON_BODY_LIMIT', 32 * 1024, 1024),
        AGENT_HEARTBEAT_MAX_AGE_MS: readNumber('AGENT_HEARTBEAT_MAX_AGE_MS', 60000, 1000),
        CAST_MAX_CONCURRENT: readNumber('MAX_CONCURRENT_CASTS', 4, 1),
        CAST_MAX_VIEWERS: readNumber('MAX_CAST_VIEWERS', 4, 1),
        CAST_TERM_GRACE_MS: readNumber('CAST_TERM_GRACE_MS', 1000),
        CAST_KILL_GRACE_MS: readNumber('CAST_KILL_GRACE_MS', 1000),
        CAST_NO_VIEWER_STOP_MS: readNumber('CAST_NO_VIEWER_STOP_MS', 1000),
        CAST_SLOW_VIEWER_TIMEOUT_MS: readNumber('CAST_SLOW_VIEWER_TIMEOUT_MS', 5000, 1),
        CAST_MAX_PENDING_BYTES: readNumber('CAST_MAX_PENDING_BYTES', 2 * 1024 * 1024, 1024),
        CAST_RECOVERY_ATTEMPTS: readNumber('CAST_RECOVERY_ATTEMPTS', 3),
        CAST_RECOVERY_BASE_DELAY_MS: readNumber('CAST_RECOVERY_BASE_DELAY_MS', 250),
        ADB_EXECUTABLE: process.env.ADB_EXECUTABLE || 'adb',
        FFMPEG_EXECUTABLE: process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
        SCRCPY_EXECUTABLE: process.env.SCRCPY_EXECUTABLE || 'scrcpy',
        STREAM_MODE: process.env.STREAM_MODE || DEFAULT_CAST_TRANSPORT,
        STREAM_PROFILE: process.env.STREAM_PROFILE || DEFAULT_CAST_PROFILE,
        STREAM_DISPLAY_ID: process.env.STREAM_DISPLAY_ID || '',
        ICON_CACHE_ROOT: path.resolve(process.cwd(), '.cache', 'apk-icons'),
        ICON_PUBLIC_ROOT: path.resolve(process.cwd(), 'public', 'app-icons'),
        WIRELESS_STATE_PATH: path.resolve(process.cwd(), '.cache', 'local-hub', 'wireless-state.json'),
        AGENT_CREDENTIALS_PATH: path.resolve(process.cwd(), '.cache', 'local-hub', 'agent-credentials.json'),
        COMMAND_STATE_PATH: path.resolve(process.cwd(), '.cache', 'local-hub', 'command-state.sqlite'),
        WIRELESS_SETUP_RETRY_MS: Number(process.env.WIRELESS_SETUP_RETRY_MS || 60000),
        WIRELESS_ADB_PORT: Number(process.env.WIRELESS_ADB_PORT || 5555),
        HEARTBEAT_LOG_INTERVAL_MS: Number(process.env.HEARTBEAT_LOG_INTERVAL_MS || 15000),
        BOOTSTRAP_TIMEOUT_MS: Number(process.env.BOOTSTRAP_TIMEOUT_MS || 5000),
        ADB_COMMAND_TIMEOUT_MS: Number(process.env.ADB_COMMAND_TIMEOUT_MS || 5000),
        AUTO_START_AGENT_RETRY_MS: Number(process.env.AUTO_START_AGENT_RETRY_MS || 20000),
        SESSION_CLEANUP_CONFIRM_TIMEOUT_MS: Number(process.env.SESSION_CLEANUP_CONFIRM_TIMEOUT_MS || 5000),
        MAX_SCREENCAP_BYTES: Number(process.env.MAX_SCREENCAP_BYTES || 8 * 1024 * 1024),
        AGENT_PACKAGES: new Set(),
        HUB_INSTANCE_ID: process.env.HUB_INSTANCE_ID || crypto.randomUUID(),
        LOCAL_HUB_DISABLE_AUTOSTART: process.env.LOCAL_HUB_DISABLE_AUTOSTART === '1',
    };
    config.APK_ICON_CACHE_ROOT = path.join(config.ICON_CACHE_ROOT, 'apks');
    config.QUEST_AGENT_ARTIFACT_ID = path.basename(config.QUEST_AGENT_APK_PATH);
    config.ICON_CACHE_INDEX_PATH = path.join(config.ICON_CACHE_ROOT, 'index.json');
    config.AGENT_PACKAGES = new Set(['com.bizonvr.spatialspike', config.QUEST_AGENT_PACKAGE]);
    return Object.freeze(config);
}

export function buildAgentComponent(config) {
    return `${config.QUEST_AGENT_PACKAGE}/${config.QUEST_AGENT_MAIN_ACTIVITY}`;
}

export function toWirelessSerial(ip, port) {
    return `${ip}:${port}`;
}

export function isLoopbackHubHost(host) {
    return isLoopbackHost(host);
}
