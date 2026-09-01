import { executeWithAdbRecovery, isSafeAdbRetry } from '../adb-command-executor.js';

export function createCommandWorker({ config, routing, dispatcher, getCommandPolicy, log = () => {} } = {}) {
    const locks = new Map();
    const metrics = routing.adbCommandMetricsByStableSerial;

    function runWithDeviceLock(lockKey, task) {
        const previous = locks.get(lockKey) || Promise.resolve();
        const next = previous.catch(() => {}).then(task).finally(() => {
            if (locks.get(lockKey) === next) locks.delete(lockKey);
        });
        locks.set(lockKey, next);
        return next;
    }

    async function runCommand(deviceSerial, commandType, payloadStr, commandMeta = {}) {
        let payload = {};
        try { payload = typeof payloadStr === 'string' ? JSON.parse(payloadStr || '{}') : (payloadStr || {}); } catch {}
        const stableSerial = routing.resolveStableSerial(deviceSerial);
        const execute = () => dispatcher.dispatch(deviceSerial, commandType, payloadStr, commandMeta);
        const operation = async () => {
            if (['RECONNECT_ADB', 'FORGET_DEVICE', 'RUN_DIAGNOSTICS'].includes(commandType)) return execute();
            const result = await executeWithAdbRecovery({
                stableSerial,
                commandType,
                resolveRoute: async (stable) => (await routing.resolveRouteForCommand(stable, commandType, payload)).selectedRoute,
                healthCheck: (route) => routing.isAdbRouteOnline(route),
                execute,
                recover: async (stable, context) => {
                    const state = await routing.supervisor.forceReconnect(stable, { route: routing.routes[stable], heartbeatIp: routing.findAgentHeartbeatForRoute(routing.routes[stable] || {})?.local_ip || null, reason: 'command_transport_failure', failedRoute: context.failedRoute });
                    if (state?.status !== 'online') return false;
                    await routing.refreshDeviceRouting(false);
                    return true;
                },
                retryable: isSafeAdbRetry(commandType),
                onEvent: (event) => log('ADB', 'ADB command recovery event', event),
            });
            const previous = metrics.get(stableSerial) || { commandTimeout: 0, lastSuccessfulCommand: null };
            metrics.set(stableSerial, { ...previous, commandTimeout: previous.commandTimeout + (result?.timedOut ? 1 : 0), lastSuccessfulCommand: result?.success ? { type: commandType, at: Date.now() } : previous.lastSuccessfulCommand });
            return result;
        };
        return runWithDeviceLock(stableSerial, operation);
    }

    return Object.freeze({ runCommand, runCommandOnce: dispatcher.dispatch, runWithDeviceLock, locks });
}
