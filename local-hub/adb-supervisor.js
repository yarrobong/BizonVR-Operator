import { reportAdbRecoveryStatus } from './adb-recovery-adapter.js';

function uniq(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

export function buildReconnectCandidates({ lastKnownIp = null, previousIps = [], heartbeatIp = null } = {}) {
  return uniq([heartbeatIp, lastKnownIp, ...previousIps]);
}

function nextBackoffMs(attempt, baseBackoffMs, maxBackoffMs, jitterRatio, random) {
  const exponent = Math.max(0, attempt - 1);
  const bounded = Math.min(maxBackoffMs, baseBackoffMs * (2 ** exponent));
  const jitter = bounded * Math.max(0, jitterRatio) * ((random() * 2) - 1);
  return Math.max(0, Math.round(bounded + jitter));
}

function classifyConnectFailure(message, portReachable) {
  const normalized = String(message || '').toLowerCase();
  if (normalized.includes('unauthorized')) return 'unauthorized';
  if (normalized.includes('different') || normalized.includes('mismatch')) return 'different_device';
  if (normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('connection refused') || normalized.includes('cannot connect') || normalized.includes('failed to connect')) {
    return portReachable ? 'tcpip_unavailable' : 'port_closed';
  }
  if (normalized.includes('no route') || normalized.includes('network is unreachable') || normalized.includes('timed out')) return 'port_closed';
  if (normalized.includes('daemon') || normalized.includes('server')) return 'adb_server_unavailable';
  return portReachable ? 'offline' : 'port_closed';
}

function routeFingerprint(route, heartbeatIp) {
  return [route?.ip || '', route?.wirelessSerial || '', heartbeatIp || ''].join('|');
}

export function createAdbSupervisor({
  port = 5555,
  debounceMs = 5000,
  baseBackoffMs = 15000,
  maxBackoffMs = 120000,
  jitterRatio = 0.2,
  now = () => Date.now(),
  random = Math.random,
  log = () => {},
  getKnownState = () => ({}),
  rememberRoute = () => {},
  checkRoutePortOpen = async () => false,
  adbDisconnect = async () => ({ success: true }),
  adbConnect = async () => ({ success: false, message: 'ADB connector is not configured.' }),
  verifyRouteIdentity = async () => ({ matched: false, message: 'ADB identity verifier is not configured.' }),
  checkAdbRecoveryPermission = () => ({ allowed: false, status: 'permission_missing', message: 'ADB recovery permission is missing.' }),
  tryEnableWirelessAdb = async () => ({ success: false, status: 'permission_missing', message: 'Wireless ADB recovery is not configured.' }),
} = {}) {
  const states = new Map();
  const flights = new Map();

  function initialState() {
    return { status: 'idle', attemptCount: 0, nextAttemptAt: 0, generation: 0, routeVersion: 0, inFlight: false, lastCandidateIp: null, recovery: null, metrics: { reconnectCount: 0, reconnectSuccess: 0, reconnectFailure: 0 } };
  }
  function getState(stableSerial) { return states.get(stableSerial) || null; }
  function updateState(stableSerial, patch) {
    const previous = getState(stableSerial) || initialState();
    const next = { ...previous, ...patch };
    states.set(stableSerial, next);
    return next;
  }
  function markRouteInput(stableSerial, options) {
    const current = getState(stableSerial) || initialState();
    const fingerprint = routeFingerprint(options.route, options.heartbeatIp);
    if (current.routeFingerprint !== fingerprint) {
      return updateState(stableSerial, { routeFingerprint: fingerprint, routeVersion: current.routeVersion + 1, latestOptions: options });
    }
    return updateState(stableSerial, { latestOptions: options });
  }
  function logTransition(stableSerial, previous, next, details = {}) {
    if (previous !== next || details.forceLog) log('ADB Supervisor', `ADB state ${stableSerial}: ${previous} -> ${next}`, { stableSerial, previousState: previous, newState: next, ...details });
  }
  function isGenerationCurrent(stableSerial, generation) {
    return getState(stableSerial)?.generation === generation;
  }

  async function runReconnect(stableSerial, initialOptions = {}) {
    const first = markRouteInput(stableSerial, initialOptions);
    const generation = first.generation + 1;
    const attempt = Number(first.attemptCount || 0) + 1;
    const startedAt = now();
    const permission = checkAdbRecoveryPermission();
    const recovery = reportAdbRecoveryStatus(permission);
    updateState(stableSerial, { generation, status: 'reconnecting', inFlight: true, attemptCount: attempt, lastStartedAt: startedAt, lastReconnectReason: initialOptions.reason || 'health_check', recovery, metrics: { ...first.metrics, reconnectCount: first.metrics.reconnectCount + 1 } });
    logTransition(stableSerial, first.status, 'reconnecting', { attempt, generation, reason: initialOptions.reason || 'health_check' });

    while (true) {
      const latest = getState(stableSerial)?.latestOptions || initialOptions;
      const knownState = getKnownState(stableSerial) || {};
      const route = latest.route || {};
      const candidates = buildReconnectCandidates({ lastKnownIp: route.ip || knownState.ip || null, previousIps: knownState.previousIps || [], heartbeatIp: latest.heartbeatIp || null });
      updateState(stableSerial, { candidates });
      if (candidates.length === 0) return finishFailure(stableSerial, generation, 'offline', 'No remembered Wi-Fi routes are available for ADB recovery.', nextBackoffMs(attempt, baseBackoffMs, maxBackoffMs, jitterRatio, random), startedAt);

      const versionAtStart = getState(stableSerial)?.routeVersion;
      for (const ip of candidates) {
        const serial = `${ip}:${port}`;
        const candidateStartedAt = now();
        updateState(stableSerial, { lastCandidateIp: ip, status: 'reconnecting' });
        let portReachable = false;
        try { portReachable = await checkRoutePortOpen(ip, port); } catch (error) { updateState(stableSerial, { lastError: error instanceof Error ? error.message : String(error) }); }
        if (!isGenerationCurrent(stableSerial, generation)) return getState(stableSerial);
        if (!portReachable) {
          updateState(stableSerial, { status: 'port_closed', lastError: `TCP ${port} is closed on ${ip}.` });
          continue;
        }
        try {
          if (route.wirelessSerial && route.wirelessSerial !== serial) await adbDisconnect(route.wirelessSerial);
          if (!isGenerationCurrent(stableSerial, generation)) return getState(stableSerial);
          const connectResult = await adbConnect(serial);
          if (!isGenerationCurrent(stableSerial, generation)) return getState(stableSerial);
          if (!connectResult?.success) {
            const status = classifyConnectFailure(connectResult?.message, true);
            if (status === 'unauthorized') return finishFailure(stableSerial, generation, status, connectResult.message || `ADB authorization required for ${serial}.`, 0, startedAt);
            updateState(stableSerial, { status, lastError: connectResult?.message || `ADB connect failed for ${serial}.` });
            if (status === 'tcpip_unavailable' && permission.allowed) {
              const recoveryAttempt = await tryEnableWirelessAdb({ stableSerial, route, ip });
              if (!isGenerationCurrent(stableSerial, generation)) return getState(stableSerial);
              updateState(stableSerial, { recovery: reportAdbRecoveryStatus(permission, recoveryAttempt) });
            }
            continue;
          }
          const verifiedIdentity = await verifyRouteIdentity({ stableSerial, serial, expectedStableId: route.stableSerial || stableSerial, expectedAndroidId: route.androidId || knownState.androidId || null });
          if (!isGenerationCurrent(stableSerial, generation)) return getState(stableSerial);
          if (!verifiedIdentity?.matched) {
            await adbDisconnect(serial);
            updateState(stableSerial, { status: 'different_device', lastError: verifiedIdentity?.message || `ADB route ${serial} did not match expected Quest identity.` });
            continue;
          }
          const latestAfterProbe = getState(stableSerial)?.latestOptions || initialOptions;
          if (latestAfterProbe.heartbeatIp && latestAfterProbe.heartbeatIp !== ip && getState(stableSerial)?.routeVersion !== versionAtStart) {
            await adbDisconnect(serial);
            continue;
          }
          rememberRoute(stableSerial, { ip, wirelessSerial: serial, androidId: verifiedIdentity.androidId || route.androidId || knownState.androidId || null, stableSerial: verifiedIdentity.stableId || stableSerial, hadSuccessfulWifiConnection: true, lastVerifiedWirelessAt: now() });
          const elapsedMs = Math.max(0, now() - startedAt);
          const state = getState(stableSerial);
          return updateState(stableSerial, { status: 'online', inFlight: false, attemptCount: 0, backoffMs: 0, lastError: null, lastConnectedAt: now(), nextAttemptAt: now() + debounceMs, recovery: reportAdbRecoveryStatus(permission, { status: 'ready', message: 'ADB route verified.' }), metrics: { ...state.metrics, reconnectSuccess: state.metrics.reconnectSuccess + 1 }, lastReconnect: { stableSerial, attempt, generation, candidate: serial, elapsedMs, result: 'success' } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateState(stableSerial, { status: classifyConnectFailure(message, portReachable), lastError: message });
        } finally {
          log('ADB Supervisor', 'ADB reconnect candidate finished', { stableSerial, attempt, generation, candidate: serial, elapsedMs: Math.max(0, now() - candidateStartedAt) });
        }
      }
      if (getState(stableSerial)?.routeVersion !== versionAtStart) continue;
      const current = getState(stableSerial);
      const backoffMs = nextBackoffMs(attempt, baseBackoffMs, maxBackoffMs, jitterRatio, random);
      return finishFailure(stableSerial, generation, current?.status || 'offline', current?.lastError || 'All ADB recovery routes failed.', backoffMs, startedAt);
    }
  }

  function finishFailure(stableSerial, generation, status, errorMessage, backoffMs, startedAt) {
    const current = getState(stableSerial);
    if (!current || current.generation !== generation) return current;
    const next = updateState(stableSerial, { status, inFlight: false, lastError: errorMessage, nextAttemptAt: backoffMs ? now() + backoffMs : 0, backoffMs, lastReconnect: { stableSerial, attempt: current.attemptCount, generation, elapsedMs: Math.max(0, now() - startedAt), result: 'failure', errorCategory: status }, metrics: { ...current.metrics, reconnectFailure: current.metrics.reconnectFailure + 1 } });
    logTransition(stableSerial, 'reconnecting', status, { generation, attempt: current.attemptCount, errorCategory: status, backoffMs });
    return next;
  }

  function startReconnect(stableSerial, options = {}) {
    const existing = flights.get(stableSerial);
    if (existing) { markRouteInput(stableSerial, options); return existing; }
    const flight = runReconnect(stableSerial, options).finally(() => { if (flights.get(stableSerial) === flight) flights.delete(stableSerial); });
    flights.set(stableSerial, flight);
    return flight;
  }

  async function tick(route, options = {}) {
    const stableSerial = route?.stableSerial;
    if (!stableSerial) return null;
    const current = markRouteInput(stableSerial, { ...options, route });
    if (route.adbState === 'online') {
      const cancelled = current.inFlight
        ? { generation: current.generation + 1, routeVersion: current.routeVersion, inFlight: false }
        : {};
      return updateState(stableSerial, { ...cancelled, status: 'online', inFlight: false, attemptCount: 0, backoffMs: 0, lastError: null, nextAttemptAt: now() + debounceMs });
    }
    if (route.adbState === 'unauthorized') return updateState(stableSerial, { status: 'unauthorized', inFlight: false, lastError: 'ADB authorization is required on the headset.', nextAttemptAt: 0 });
    if (!options.force && current.status === 'unauthorized') return current;
    const hasRecoverySignal = Boolean(route.agentOnline || route.ip || (getKnownState(stableSerial)?.previousIps || []).length);
    if (!hasRecoverySignal) return current;
    if (!options.force && current.inFlight) return flights.get(stableSerial) || current;
    if (!options.force && current.nextAttemptAt && current.nextAttemptAt > now()) return current;
    log('ADB Supervisor', `Reconnecting ${stableSerial}`, { force: Boolean(options.force), reason: options.reason || 'health_check' });
    return startReconnect(stableSerial, { ...options, route });
  }

  return {
    getState,
    getMetrics: (stableSerial) => getState(stableSerial)?.metrics || null,
    getInFlightCount: () => flights.size,
    getStateCount: () => states.size,
    forget(stableSerial) {
      const current = getState(stableSerial);
      if (current) updateState(stableSerial, { generation: current.generation + 1, inFlight: false, status: 'forgotten' });
      states.delete(stableSerial);
      return true;
    },
    tick,
    forceReconnect(stableSerial, options = {}) { return startReconnect(stableSerial, { ...options, force: true }); },
  };
}
