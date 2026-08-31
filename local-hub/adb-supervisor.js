import { reportAdbRecoveryStatus } from './adb-recovery-adapter.js';

function uniq(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

export function buildReconnectCandidates({ lastKnownIp = null, previousIps = [], heartbeatIp = null } = {}) {
  return uniq([heartbeatIp, lastKnownIp, ...previousIps]);
}

function nextBackoffMs(attempt, baseBackoffMs, maxBackoffMs) {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxBackoffMs, baseBackoffMs * (2 ** exponent));
}

function classifyConnectFailure(message, portReachable) {
  const normalized = String(message || '').toLowerCase();
  if (normalized.includes('unauthorized')) {
    return 'unauthorized';
  }
  if (normalized.includes('connection refused') || normalized.includes('cannot connect') || normalized.includes('failed to connect')) {
    return portReachable ? 'tcpip_unavailable' : 'port_closed';
  }
  if (normalized.includes('no route to host') || normalized.includes('network is unreachable') || normalized.includes('timed out')) {
    return 'port_closed';
  }
  return portReachable ? 'offline' : 'port_closed';
}

export function createAdbSupervisor({
  port = 5555,
  debounceMs = 5000,
  baseBackoffMs = 15000,
  maxBackoffMs = 120000,
  now = () => Date.now(),
  log = () => {},
  getKnownState,
  rememberRoute,
  checkRoutePortOpen,
  adbDisconnect,
  adbConnect,
  verifyRouteIdentity,
  checkAdbRecoveryPermission,
  tryEnableWirelessAdb,
} = {}) {
  const states = new Map();

  function getState(stableSerial) {
    return states.get(stableSerial) || null;
  }

  function updateState(stableSerial, patch) {
    const prev = getState(stableSerial) || {
      status: 'idle',
      attemptCount: 0,
      nextAttemptAt: 0,
      lastCandidateIp: null,
      recovery: null,
    };
    const next = { ...prev, ...patch };
    states.set(stableSerial, next);
    return next;
  }

  async function runReconnect(stableSerial, options = {}) {
    const route = options.route || {};
    const knownState = getKnownState(stableSerial) || {};
    const permission = checkAdbRecoveryPermission();
    const recovery = reportAdbRecoveryStatus(permission);
    const candidates = buildReconnectCandidates({
      lastKnownIp: route.ip || knownState.ip || null,
      previousIps: knownState.previousIps || [],
      heartbeatIp: options.heartbeatIp || null,
    });

    if (candidates.length === 0) {
      return updateState(stableSerial, {
        status: 'offline',
        lastError: 'No remembered Wi-Fi routes are available for ADB recovery.',
        recovery,
      });
    }

    updateState(stableSerial, {
      status: 'reconnecting',
      inFlight: true,
      attemptCount: Number(getState(stableSerial)?.attemptCount || 0) + 1,
      lastStartedAt: now(),
      candidates,
      recovery,
    });

    for (const ip of candidates) {
      const serial = `${ip}:${port}`;
      const portReachable = await checkRoutePortOpen(ip, port);
      updateState(stableSerial, { lastCandidateIp: ip });

      if (!portReachable) {
        updateState(stableSerial, {
          status: 'port_closed',
          lastError: `TCP ${port} is closed on ${ip}.`,
        });
        continue;
      }

      try {
        if (route.wirelessSerial && route.wirelessSerial !== serial) {
          await adbDisconnect(route.wirelessSerial);
        }

        const connectResult = await adbConnect(serial);
        if (!connectResult?.success) {
          const status = classifyConnectFailure(connectResult?.message, true);
          updateState(stableSerial, {
            status,
            lastError: connectResult?.message || `ADB connect failed for ${serial}.`,
          });

          if (status === 'tcpip_unavailable' && permission.allowed) {
            const recoveryAttempt = await tryEnableWirelessAdb({ stableSerial, route, ip });
            updateState(stableSerial, {
              recovery: reportAdbRecoveryStatus(permission, recoveryAttempt),
            });
          }
          continue;
        }

        const verifiedIdentity = await verifyRouteIdentity({
          stableSerial,
          serial,
          expectedStableId: route.stableSerial || stableSerial,
          expectedAndroidId: route.androidId || knownState.androidId || null,
        });

        if (!verifiedIdentity?.matched) {
          await adbDisconnect(serial);
          updateState(stableSerial, {
            status: 'different_device',
            lastError: verifiedIdentity?.message || `ADB route ${serial} did not match the expected Quest identity.`,
          });
          continue;
        }

        rememberRoute(stableSerial, {
          ip,
          wirelessSerial: serial,
          androidId: verifiedIdentity.androidId || route.androidId || knownState.androidId || null,
          stableSerial: verifiedIdentity.stableId || stableSerial,
          hadSuccessfulWifiConnection: true,
          lastVerifiedWirelessAt: now(),
        });
        return updateState(stableSerial, {
          status: 'online',
          inFlight: false,
          lastError: null,
          lastConnectedAt: now(),
          nextAttemptAt: now() + debounceMs,
          recovery: reportAdbRecoveryStatus(permission, { status: 'ready', message: 'ADB route verified.' }),
        });
      } catch (error) {
        updateState(stableSerial, {
          status: classifyConnectFailure(error instanceof Error ? error.message : String(error), true),
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const current = getState(stableSerial);
    const attempts = Number(current?.attemptCount || 1);
    const backoffMs = nextBackoffMs(attempts, baseBackoffMs, maxBackoffMs);
    return updateState(stableSerial, {
      inFlight: false,
      nextAttemptAt: now() + backoffMs,
      backoffMs,
    });
  }

  async function tick(route, options = {}) {
    const stableSerial = route?.stableSerial;
    if (!stableSerial) {
      return null;
    }

    const current = getState(stableSerial);
    if (route.adbState === 'online') {
      return updateState(stableSerial, {
        status: 'online',
        inFlight: false,
        lastError: null,
        nextAttemptAt: now() + debounceMs,
      });
    }
    if (route.adbState === 'unauthorized') {
      return updateState(stableSerial, {
        status: 'unauthorized',
        inFlight: false,
        lastError: 'ADB authorization is required on the headset.',
      });
    }

    const hasRecoverySignal = Boolean(route.agentOnline || route.ip || (getKnownState(stableSerial)?.previousIps || []).length);
    if (!hasRecoverySignal) {
      return current;
    }
    if (!options.force && current?.inFlight) {
      return current;
    }
    if (!options.force && current?.nextAttemptAt && current.nextAttemptAt > now()) {
      return current;
    }

    log('ADB Supervisor', `Reconnecting ${stableSerial}`, { force: Boolean(options.force) });
    return runReconnect(stableSerial, options);
  }

  return {
    getState,
    tick,
    forceReconnect(stableSerial, options = {}) {
      return runReconnect(stableSerial, { ...options, force: true });
    },
  };
}
