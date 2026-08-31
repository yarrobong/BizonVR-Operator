import { isAdbTransportFailure } from './adb-process-runner.js';

const SAFE_RETRY_COMMANDS = new Set([
  'GET_STATE', 'PING', 'REFRESH_STATUS', 'OPEN_LAUNCHER', 'RELAUNCH_AGENT',
  'OPEN_SCRCPY', 'CLOSE_SCRCPY',
]);

export function isSafeAdbRetry(commandType) {
  return SAFE_RETRY_COMMANDS.has(String(commandType || '').toUpperCase());
}

export async function executeWithAdbRecovery({
  stableSerial,
  commandType,
  resolveRoute,
  healthCheck,
  execute,
  recover,
  retryable = isSafeAdbRetry(commandType),
  onEvent = () => {},
} = {}) {
  let route = await resolveRoute(stableSerial, { commandType });
  if (!route) return { success: false, error: `No current ADB route is available for ${stableSerial}.`, category: 'route_unavailable' };

  const run = async (attempt) => {
    const healthy = await healthCheck(route, { stableSerial, commandType });
    if (!healthy) {
      onEvent({ type: 'stale_route', stableSerial, route, attempt });
      return { success: false, error: `ADB route ${route} is no longer healthy.`, category: 'stale_route', transportFailure: true };
    }
    onEvent({ type: 'execute', stableSerial, route, attempt });
    return execute(route, { stableSerial, commandType, attempt });
  };

  let result;
  try {
    result = await run(0);
  } catch (error) {
    result = { success: false, error: error instanceof Error ? error.message : String(error), category: 'adb_error', transportFailure: isAdbTransportFailure(error) };
  }
  if (result?.success !== false) return result;

  const transportFailure = Boolean(result?.transportFailure || result?.timedOut || isAdbTransportFailure(result?.error || result));
  if (!transportFailure || !recover) return result;
  onEvent({ type: 'recover', stableSerial, route, commandType });
  const recovered = await recover(stableSerial, { failedRoute: route, commandType });
  if (!recovered) return { ...result, category: result.category || 'recovery_failed' };
  if (!retryable) return { ...result, category: 'not_retried_after_recovery', recovered: true };

  // Resolve the route again. A successful recovery is allowed to change the
  // IP, and the old route must never be reused for the retry.
  route = await resolveRoute(stableSerial, { commandType, afterRecovery: true });
  if (!route) return { success: false, error: `ADB recovered but no current route was published for ${stableSerial}.`, category: 'route_unavailable_after_recovery' };
  try {
    const retryResult = await run(1);
    return { ...retryResult, recovered: true, retried: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), category: 'retry_failed', recovered: true, retried: true };
  }
}

export { SAFE_RETRY_COMMANDS };
