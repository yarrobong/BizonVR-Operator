import { createAdbProcessRunner } from './adb-process-runner.js';
import { createCastManager, terminateOwnedProcess } from './cast-manager.js';
import { createExecutionStore, getCommandPolicy } from './command-reliability.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createAdbHelpers } from './adb/helpers.js';
import { createAgentAuthenticator } from './agent/auth.js';
import { createAgentCredentialStore } from './agent/credentials.js';
import { createAgentServer } from './agent/server.js';
import { createHeartbeatStore } from './agent/heartbeat-store.js';
import { createAgentProvisioning } from './agent/provisioning.js';
import { createCloudClient } from './cloud/client.js';
import { createHubSync } from './cloud/sync.js';
import { createAppDiscovery, isValidPackage } from './devices/apps.js';
import { createDeviceDiagnostics } from './devices/diagnostics.js';
import { createDeviceRouter } from './devices/routing.js';
import { createCommandDispatcher } from './commands/dispatcher.js';
import { createCommandReconciler } from './commands/reconciliation.js';
import { createCommandWorker } from './commands/worker.js';
import { createCastService } from './cast/service.js';
import { createLifecycle } from './lifecycle/shutdown.js';

const config = loadConfig();
const logger = createLogger();
const log = logger.log;
const adbProcessRunner = createAdbProcessRunner({ defaultTimeoutMs: config.ADB_COMMAND_TIMEOUT_MS });
const adb = createAdbHelpers({ config, runner: adbProcessRunner, log });
const executionStore = createExecutionStore(process.env.COMMAND_STATE_PATH || config.COMMAND_STATE_PATH);
executionStore.prune();
const heartbeatStore = createHeartbeatStore();
const credentialStore = createAgentCredentialStore(config.AGENT_CREDENTIALS_PATH);
const cloud = createCloudClient({ apiUrl: config.API_URL, hubId: config.HUB_ID, hubToken: config.HUB_TOKEN, hubInstanceId: config.HUB_INSTANCE_ID, timeoutMs: config.BOOTSTRAP_TIMEOUT_MS, log });
const scrcpyProcesses = new Map();

const routing = createDeviceRouter({
    config,
    runAdbCapture: adb.capture,
    heartbeatStore,
    getScrcpyProcesses: () => scrcpyProcesses,
    onStaleCastRoute: (stableSerial, owner, nextRoute) => {
        log('Cast', 'Stopping scrcpy owned by a stale ADB route', { stableSerial, oldRoute: owner.route, newRoute: nextRoute, errorCode: 'STALE_ROUTE' });
        void terminateOwnedProcess(owner.process, { termGraceMs: config.CAST_TERM_GRACE_MS, killGraceMs: config.CAST_KILL_GRACE_MS, log })
            .finally(() => { if (scrcpyProcesses.get(stableSerial) === owner) scrcpyProcesses.delete(stableSerial); });
    },
    log,
});

const castManager = createCastManager({
    maxConcurrentCasts: config.CAST_MAX_CONCURRENT,
    maxViewersPerCast: config.CAST_MAX_VIEWERS,
    bootTimeoutMs: config.STREAM_BOOT_TIMEOUT_MS,
    termGraceMs: config.CAST_TERM_GRACE_MS,
    killGraceMs: config.CAST_KILL_GRACE_MS,
    noViewerStopMs: config.CAST_NO_VIEWER_STOP_MS,
    slowViewerTimeoutMs: config.CAST_SLOW_VIEWER_TIMEOUT_MS,
    maxPendingBytes: config.CAST_MAX_PENDING_BYTES,
    recoveryAttempts: config.CAST_RECOVERY_ATTEMPTS,
    recoveryBaseDelayMs: config.CAST_RECOVERY_BASE_DELAY_MS,
    resolveRoute: async ({ record }) => {
        const route = await routing.resolveExecutionSerial(record.key);
        if (!route) return null;
        const actualStable = await routing.getDeviceStableSerial(route);
        if (!actualStable || actualStable !== record.key) {
            log('Cast', 'Refusing recovery on a route with mismatched identity', { castId: record.castId, stableSerial: record.key, route, actualStable, errorCode: 'DEVICE_IDENTITY_MISMATCH' });
            return null;
        }
        return route;
    },
    log,
});

const appDiscovery = createAppDiscovery({ config, runAdbCapture: adb.capture, log });
const diagnostics = createDeviceDiagnostics({ config, runAdbCapture: adb.capture });
const provisioning = createAgentProvisioning({ config, credentialStore, runAdb: adb.run, resolveStableSerial: routing.resolveStableSerial, log });
const dispatcher = createCommandDispatcher({ config, runner: adb, routing, appDiscovery, credentialStore, provisioning, diagnostics, castRegistry: castManager.getRegistry(), log });
const worker = createCommandWorker({ config, routing, dispatcher, getCommandPolicy, log });
const reconciler = createCommandReconciler({ config, runAdbCapture: adb.capture, getCurrentForegroundPackage: diagnostics.getCurrentForegroundPackage, findAgentHeartbeatForRoute: routing.findAgentHeartbeatForRoute, isValidPackage });
const sync = createHubSync({ config, cloud, executionStore, routing, heartbeatStore, appDiscovery, diagnostics, provisioning, runner: adb, worker, reconciler, log });
const cast = createCastService({ config, routing, runner: adb, diagnostics, castManager, wakeDevice: dispatcher.wakeDevice, scrcpyProcesses, log });
const authenticator = createAgentAuthenticator({ credentials: credentialStore, heartbeatMaxAgeMs: config.AGENT_HEARTBEAT_MAX_AGE_MS, heartbeatStore });
const agent = createAgentServer({ config, auth: authenticator, heartbeatStore, routing, cloud, streamDeviceFrames: cast.streamDeviceFrames, log });
let syncPollTimer = null;
const lifecycle = createLifecycle({ server: agent.server, castManager, scrcpyProcesses, executionStore, config, clearSyncTimer: () => { if (syncPollTimer) clearInterval(syncPollTimer); }, log });

log('Local Hub', `Starting Local Hub (${config.HUB_ID}) connecting to ${config.API_URL}`);
log('Local Hub', `Agent callback target: http://${config.HUB_HOST}:${config.LOCAL_SERVER_PORT}`);

process.on('uncaughtException', (error) => {
    logger.error('[Local Hub] uncaughtException', { message: error?.message || String(error), stack: error?.stack || null, active_casts: Array.from(cast.activeCastStreams.entries()).map(([route, stream]) => ({ route, transport: stream.transport, profile: stream.profile, startedAt: stream.startedAt })) });
});
process.on('unhandledRejection', (reason) => {
    logger.error('[Local Hub] unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack || null } : String(reason), active_casts: Array.from(cast.activeCastStreams.entries()).map(([route, stream]) => ({ route, transport: stream.transport, profile: stream.profile, startedAt: stream.startedAt })) });
});

process.once('SIGTERM', () => { void lifecycle.shutdown('SIGTERM').finally(() => { process.exitCode = 0; }); });
process.once('SIGINT', () => { void lifecycle.shutdown('SIGINT').finally(() => { process.exitCode = 0; }); });

export const runCommandOnce = worker.runCommandOnce;
export const shutdownLocalHub = lifecycle.shutdown;
export { config, routing, agent, cast, sync };

if (!config.LOCAL_HUB_DISABLE_AUTOSTART) {
    agent.server.listen(config.LOCAL_SERVER_PORT, '0.0.0.0', () => {
        console.log(`[Local Hub Mini-Server] Listening for Agent heartbeats on port ${config.LOCAL_SERVER_PORT}`);
        sync.bootstrapKnownDevices().finally(() => {
            syncPollTimer = setInterval(sync.syncWithCloud, config.POLL_INTERVAL_MS);
            sync.syncWithCloud();
        });
    });
}
