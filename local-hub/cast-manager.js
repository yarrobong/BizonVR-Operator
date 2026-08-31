import { EventEmitter } from 'node:events';

const DEFAULTS = {
  maxConcurrentCasts: 4,
  maxViewersPerCast: 4,
  bootTimeoutMs: 7000,
  termGraceMs: 1000,
  killGraceMs: 1000,
  noViewerStopMs: 1000,
  slowViewerTimeoutMs: 5000,
  maxPendingBytes: 2 * 1024 * 1024,
  recoveryAttempts: 3,
  recoveryBaseDelayMs: 250,
  replayBytes: 256 * 1024,
};

const CAST_STATES = new Set([
  'idle',
  'starting',
  'streaming',
  'reconnecting',
  'stopping',
  'failed',
]);

function asError(error, fallback = 'Cast pipeline failed') {
  return error instanceof Error ? error : new Error(error?.message || String(error || fallback));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWritable(response) {
  return Boolean(response) && !response.destroyed && !response.writableEnded;
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return false;
  }
}

function onceExit(child) {
  if (!child || typeof child.once !== 'function') return Promise.resolve();
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
}

export async function terminateOwnedProcess(child, {
  termGraceMs = 1000,
  killGraceMs = 1000,
  log = () => undefined,
} = {}) {
  if (!child) return { stopped: false, alreadyExited: true };
  if (child.exitCode !== null && child.exitCode !== undefined || child.killed) {
    return { stopped: false, alreadyExited: true };
  }

  const exited = onceExit(child);
  safeCall(() => child.kill('SIGTERM'));
  let timer = setTimeout(() => undefined, termGraceMs);
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), termGraceMs); }),
  ]);
  clearTimeout(timer);
  if (graceful) return { stopped: true, forced: false };

  log('Cast', 'Owned process ignored SIGTERM; escalating to SIGKILL', {
    pid: child.pid || null,
  });
  safeCall(() => child.kill('SIGKILL'));
  let killTimer = setTimeout(() => undefined, killGraceMs);
  const forced = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => { killTimer = setTimeout(() => resolve(false), killGraceMs); }),
  ]);
  clearTimeout(killTimer);
  return { stopped: forced, forced: true, timedOut: !forced };
}

export function createCastManager(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const streams = new Map();
  const metrics = {
    cast_start_total: 0,
    cast_start_success: 0,
    cast_start_failure: 0,
    cast_restart_total: 0,
    cast_process_crash: 0,
    cast_boot_timeout: 0,
    viewer_disconnect: 0,
    slow_viewer_disconnect: 0,
    bytes_sent: 0,
    first_frame_latency: [],
    cast_duration: [],
  };
  let viewerSequence = 0;
  let shuttingDown = false;

  const log = typeof config.log === 'function' ? config.log : () => undefined;

  function setState(record, state, extra = {}) {
    if (!CAST_STATES.has(state)) throw new Error(`Unknown cast state ${state}`);
    record.state = state;
    Object.assign(record, extra);
    record.events.emit('state', { state, record });
    log('Cast', 'Cast state changed', {
      castId: record.castId,
      generation: record.generation,
      stableSerial: record.key,
      route: record.route,
      state,
      viewerCount: record.viewers.size,
      processPid: record.processPids?.[0] || null,
      ffmpegPid: record.processPids?.[1] || null,
      ...extra,
    });
  }

  function publicRecord(record) {
    if (!record) return null;
    return {
      castId: record.castId,
      generation: record.generation,
      stableSerial: record.key,
      route: record.route,
      transport: record.transport,
      profile: record.profile,
      state: record.state,
      startedAt: record.startedAt,
      firstFrameAt: record.firstFrameAt,
      processPids: record.processPids || [],
      viewerCount: record.viewers.size,
      restartCount: record.restartCount,
      bytesSent: record.bytesSent,
      droppedChunks: record.droppedChunks,
      backpressureEvents: record.backpressureEvents,
      stopReason: record.stopReason,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      exitCode: record.exitCode ?? null,
      signal: record.signal || null,
    };
  }

  function detachViewer(record, viewer, reason = 'client_disconnect') {
    if (!record.viewers.has(viewer.id)) return false;
    record.viewers.delete(viewer.id);
    viewer.detached = true;
    viewer.req?.removeListener?.('aborted', viewer.onAbort);
    viewer.req?.removeListener?.('close', viewer.onRequestClose);
    viewer.res?.removeListener?.('close', viewer.onResponseClose);
    viewer.res?.removeListener?.('error', viewer.onResponseError);
    viewer.res?.removeListener?.('drain', viewer.onDrain);
    if (reason === 'slow_viewer') metrics.slow_viewer_disconnect += 1;
    else metrics.viewer_disconnect += 1;
    log('Cast', 'Viewer detached', {
      castId: record.castId,
      generation: record.generation,
      stableSerial: record.key,
      viewerId: viewer.id,
      reason,
      viewerCount: record.viewers.size,
    });
    if (isWritable(viewer.res) && reason === 'slow_viewer') safeCall(() => viewer.res.destroy());
    if (record.viewers.size === 0 && !record.stopPromise && !shuttingDown) {
      clearTimeout(record.noViewerTimer);
      record.noViewerTimer = setTimeout(() => {
        if (record.viewers.size === 0) void stop(record, 'last_viewer_disconnect');
      }, config.noViewerStopMs);
      record.noViewerTimer.unref?.();
    }
    return true;
  }

  function writeViewerHeaders(record, viewer) {
    if (!isWritable(viewer.res)) return false;
    if (viewer.res.headersSent) return true;
    return Boolean(safeCall(() => {
      viewer.res.writeHead(200, record.responseHeaders);
      return true;
    }));
  }

  function replayToViewer(record, viewer) {
    if (!writeViewerHeaders(record, viewer)) return false;
    for (const chunk of record.replay) {
      if (!isWritable(viewer.res)) return false;
      if (safeCall(() => viewer.res.write(chunk)) === false) {
        viewer.blockedSince = Date.now();
        viewer.backpressureEvents += 1;
        return true;
      }
    }
    return true;
  }

  function detachSlowViewerIfNeeded(record, viewer) {
    if (!viewer.blockedSince) return false;
    const pendingBytes = Number(viewer.res?.writableLength || 0);
    if (pendingBytes > config.maxPendingBytes || Date.now() - viewer.blockedSince >= config.slowViewerTimeoutMs) {
      detachViewer(record, viewer, 'slow_viewer');
      return true;
    }
    return false;
  }

  function removeOutputListeners(record) {
    const output = record.producer?.output;
    if (!record.outputListeners || !output?.removeListener) return;
    for (const [event, listener] of record.outputListeners) output.removeListener(event, listener);
    record.outputListeners = [];
  }

  function publish(record, chunk, generation) {
    if (streams.get(record.key) !== record || record.generation !== generation || record.stopPromise) return;
    if (!chunk || chunk.length === 0) return;
    record.bytesSent += chunk.length;
    record.chunkCount += 1;
    metrics.bytes_sent += chunk.length;
    if (record.replayBytes < config.replayBytes) {
      const remaining = config.replayBytes - record.replayBytes;
      const copy = Buffer.from(chunk.subarray ? chunk.subarray(0, remaining) : chunk);
      record.replay.push(copy);
      record.replayBytes += copy.length;
    }
    if (record.state === 'starting') {
      record.firstFrameAt = Date.now();
      record.firstFrameLatencyMs = record.firstFrameAt - record.startedAt;
      metrics.cast_start_success += 1;
      metrics.first_frame_latency.push(record.firstFrameLatencyMs);
      clearTimeout(record.bootTimer);
      record.bootTimer = null;
      setState(record, 'streaming');
    }
    for (const viewer of [...record.viewers.values()]) {
      if (viewer.detached) continue;
      if (!isWritable(viewer.res)) {
        detachViewer(record, viewer, 'response_destroyed');
        continue;
      }
      if (detachSlowViewerIfNeeded(record, viewer)) continue;
      if (viewer.blockedSince) {
        record.droppedChunks += 1;
        continue;
      }
      if (!viewer.headersSent) {
        if (!replayToViewer(record, viewer)) {
          detachViewer(record, viewer, 'response_header_failure');
          continue;
        }
        viewer.headersSent = true;
        // replayToViewer already sent the current first chunk.
        continue;
      }
      const accepted = safeCall(() => viewer.res.write(chunk));
      if (accepted === false) {
        viewer.blockedSince = Date.now();
        viewer.backpressureEvents += 1;
        record.backpressureEvents += 1;
      }
    }
  }

  async function stop(record, reason = 'client_disconnect') {
    if (!record) return false;
    if (record.stopPromise) return record.stopPromise;
    record.stopPromise = (async () => {
      clearTimeout(record.bootTimer);
      clearTimeout(record.noViewerTimer);
      record.stopReason = reason;
      const failedBeforeHeaders = record.state === 'failed';
      setState(record, 'stopping');
      const producer = record.producer;
      removeOutputListeners(record);
      safeCall(() => producer?.detach?.());
      for (const viewer of [...record.viewers.values()]) {
        detachViewer(record, viewer, reason === 'last_viewer_disconnect' ? 'client_disconnect' : reason);
        if (isWritable(viewer.res)) {
          if (failedBeforeHeaders && !viewer.res.headersSent) {
            safeCall(() => viewer.res.writeHead(503, { 'Content-Type': 'application/json' }));
            safeCall(() => viewer.res.end(JSON.stringify({
              error: record.errorCode || 'CAST_PIPELINE_FAILED',
              message: record.errorMessage || 'Cast pipeline failed on Local Hub.',
              state: 'failed',
              next_step: record.errorCode === 'PROCESS_SPAWN_FAILED'
                ? 'Install/configure the Local Hub capture binaries and retry the cast.'
                : 'Reconnect ADB or use diagnostic preview, then retry the cast.',
            })));
          } else {
            safeCall(() => viewer.res.end());
          }
        }
      }
      const processes = producer?.processes || [];
      await Promise.all(processes.map((child) => terminateOwnedProcess(child, {
        termGraceMs: config.termGraceMs,
        killGraceMs: config.killGraceMs,
        log,
      })));
      safeCall(() => producer?.stop?.());
      if (streams.get(record.key) === record) streams.delete(record.key);
      record.endedAt = Date.now();
      metrics.cast_duration.push(Math.max(record.endedAt - record.startedAt, 0));
      log('Cast', 'Cast resources released', {
        castId: record.castId,
        generation: record.generation,
        stableSerial: record.key,
        route: record.route,
        state: record.state,
        reason,
        elapsedMs: record.endedAt - record.startedAt,
        bytesSent: record.bytesSent,
        droppedChunks: record.droppedChunks,
        backpressureEvents: record.backpressureEvents,
      });
      return true;
    })();
    return record.stopPromise;
  }

  async function fail(record, error, { processCrash = false, beforeReady = false } = {}) {
    if (streams.get(record.key) !== record || record.stopPromise) return;
    const failure = asError(error);
    record.errorMessage = failure.message;
    record.errorCode = failure.code === 'ENOENT' ? 'PROCESS_SPAWN_FAILED' : (failure.code || 'CAST_PIPELINE_FAILED');
    if (processCrash) metrics.cast_process_crash += 1;
    if (beforeReady) metrics.cast_start_failure += 1;
    clearTimeout(record.bootTimer);
    record.bootTimer = null;
    if (beforeReady && record.fallbackProducer && !record.fallbackUsed && !shuttingDown) {
      record.fallbackUsed = true;
      record.generation += 1;
      removeOutputListeners(record);
      safeCall(() => record.producer?.detach?.());
      await Promise.all((record.producer?.processes || []).map((child) => terminateOwnedProcess(child, {
        termGraceMs: config.termGraceMs,
        killGraceMs: config.killGraceMs,
        log,
      })));
      record.producer = null;
      record.replay = [];
      record.replayBytes = 0;
      record.producerFactory = record.fallbackProducer;
      if (record.fallbackResponseHeaders) record.responseHeaders = record.fallbackResponseHeaders;
      setState(record, 'starting', { errorCode: 'CAST_PRIMARY_FAILED', errorMessage: record.errorMessage });
      beginProducer(record);
      return;
    }
    if (record.recoveryAttempts < config.recoveryAttempts && record.viewers.size > 0 && !shuttingDown && !record.recoveryPromise) {
      record.recoveryPromise = (async () => {
        record.recoveryAttempts += 1;
        record.restartCount += 1;
        metrics.cast_restart_total += 1;
        setState(record, 'reconnecting', { errorMessage: failure.message });
        record.generation += 1;
        removeOutputListeners(record);
        safeCall(() => record.producer?.detach?.());
        await Promise.all((record.producer?.processes || []).map((child) => terminateOwnedProcess(child, {
          termGraceMs: config.termGraceMs,
          killGraceMs: config.killGraceMs,
          log,
        })));
        const waitMs = config.recoveryBaseDelayMs * (2 ** (record.recoveryAttempts - 1));
        await delay(waitMs);
        if (streams.get(record.key) !== record || record.viewers.size === 0 || shuttingDown) return false;
        const nextRoute = await config.resolveRoute?.({ record, reason: failure.message, attempt: record.recoveryAttempts });
        if (!nextRoute) return false;
        record.route = nextRoute;
        record.replay = [];
        record.replayBytes = 0;
        record.producer = null;
        setState(record, 'starting', { errorMessage: null });
        beginProducer(record);
        return true;
      })().catch((recoveryError) => {
        record.errorMessage = asError(recoveryError).message;
        return false;
      }).finally(() => {
        record.recoveryPromise = null;
      });
      const recovered = await record.recoveryPromise;
      if (recovered) return;
    }
    setState(record, 'failed', { errorCode: record.errorCode, errorMessage: record.errorMessage });
    await stop(record, record.errorCode === 'CAST_BOOT_TIMEOUT' ? 'boot_timeout' : 'pipeline_failure');
  }

  function beginProducer(record) {
    const generation = record.generation;
    let producer;
    try {
      producer = (record.producerFactory || record.startProducer)({ record, generation });
      if (!producer?.output) throw new Error('Cast producer did not return an output stream');
    } catch (error) {
      void fail(record, error, { beforeReady: true });
      return;
    }
    if (streams.get(record.key) !== record || record.generation !== generation) return;
    record.producer = producer;
    record.processPids = (producer.processes || []).map((child) => child?.pid).filter(Boolean);
    const processError = (error) => void fail(record, error, { processCrash: true, beforeReady: record.state === 'starting' });
    for (const child of producer.processes || []) {
      child?.once?.('error', processError);
      child?.once?.('close', (code, signal) => {
        if (record.stopPromise || streams.get(record.key) !== record || record.generation !== generation) return;
        record.exitCode = code;
        record.signal = signal;
        const error = new Error(`${producer.name || 'Cast process'} exited${code == null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`);
        error.code = code === 0 ? 'CAST_PROCESS_EOF' : 'CAST_PROCESS_EXIT';
        void fail(record, error, { processCrash: code !== 0, beforeReady: record.state === 'starting' });
      });
    }
    const onData = (chunk) => publish(record, chunk, generation);
    const onError = (error) => void fail(record, error, { processCrash: true, beforeReady: record.state === 'starting' });
    const onEnd = () => {
      if (!record.stopPromise && streams.get(record.key) === record && record.generation === generation) {
        void fail(record, new Error('Cast output ended unexpectedly'), { processCrash: true, beforeReady: record.state === 'starting' });
      }
    };
    producer.output.on?.('data', onData);
    producer.output.once?.('error', onError);
    producer.output.once?.('end', onEnd);
    record.outputListeners = [['data', onData], ['error', onError], ['end', onEnd]];
    record.bootTimer = setTimeout(() => {
      if (record.state !== 'starting' || record.generation !== generation) return;
      metrics.cast_boot_timeout += 1;
      const error = new Error(`No usable video data produced within ${config.bootTimeoutMs}ms`);
      error.code = 'CAST_BOOT_TIMEOUT';
      void fail(record, error, { beforeReady: true });
    }, config.bootTimeoutMs);
    record.bootTimer.unref?.();
  }

  function attachViewer({ key, route, transport, profile, responseHeaders, fallbackResponseHeaders = null, req, res, startProducer, fallbackProducer = null }) {
    if (shuttingDown) return { ok: false, status: 503, body: { error: 'HUB_SHUTTING_DOWN', next_step: 'Wait for Local Hub to restart, then retry the cast.' } };
    const existing = streams.get(key);
    if (existing && (existing.state === 'stopping' || existing.state === 'failed')) {
      return { ok: false, status: 409, body: { error: 'CAST_NOT_READY', state: existing.state, next_step: 'Wait for Local Hub to finish releasing the previous cast, then retry.' } };
    }
    if (existing && (existing.transport !== transport || existing.profile !== profile)) {
      return { ok: false, status: 409, body: { error: 'CAST_ALREADY_ACTIVE', state: existing.state, active_transport: existing.transport, active_profile: existing.profile, next_step: 'Join the existing cast or stop it before changing transport/profile.' } };
    }
    if (!existing && streams.size >= config.maxConcurrentCasts) {
      return { ok: false, status: 429, body: { error: 'CAST_LIMIT_REACHED', message: `Local Hub allows ${config.maxConcurrentCasts} concurrent casts.`, next_step: 'Stop an unused cast or increase MAX_CONCURRENT_CASTS in the Local Hub configuration.' } };
    }
    const record = existing || {
      castId: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      route,
      transport,
      profile,
      state: 'idle',
      generation: 1,
      startedAt: Date.now(),
      viewers: new Map(),
      events: new EventEmitter(),
      replay: [],
      replayBytes: 0,
      bytesSent: 0,
      chunkCount: 0,
      droppedChunks: 0,
      backpressureEvents: 0,
      restartCount: 0,
      recoveryAttempts: 0,
      startProducer,
      fallbackProducer,
      fallbackResponseHeaders,
      producerFactory: startProducer,
      fallbackUsed: false,
      responseHeaders,
    };
    if (!existing) {
      streams.set(key, record);
      metrics.cast_start_total += 1;
      setState(record, 'starting');
    }
    if (record.viewers.size >= config.maxViewersPerCast) {
      return { ok: false, status: 429, body: { error: 'CAST_VIEWER_LIMIT_REACHED', message: `This cast already has ${config.maxViewersPerCast} viewers.`, next_step: 'Close an existing cast tab and retry.' } };
    }
    const viewer = {
      id: ++viewerSequence,
      req,
      res,
      headersSent: false,
      detached: false,
      blockedSince: null,
      backpressureEvents: 0,
    };
    viewer.onAbort = () => detachViewer(record, viewer, 'client_abort');
    viewer.onRequestClose = () => {
      if (req?.aborted || res?.destroyed) detachViewer(record, viewer, 'client_disconnect');
    };
    viewer.onResponseClose = () => detachViewer(record, viewer, 'response_close');
    viewer.onResponseError = () => detachViewer(record, viewer, 'response_error');
    viewer.onDrain = () => { viewer.blockedSince = null; };
    req?.once?.('aborted', viewer.onAbort);
    req?.once?.('close', viewer.onRequestClose);
    res?.once?.('close', viewer.onResponseClose);
    res?.once?.('error', viewer.onResponseError);
    res?.on?.('drain', viewer.onDrain);
    record.viewers.set(viewer.id, viewer);
    if (record.state === 'streaming') {
      if (replayToViewer(record, viewer)) viewer.headersSent = true;
    }
    if (!existing) {
      record.startProducer = startProducer;
      beginProducer(record);
    }
    return { ok: true, status: 200, body: publicRecord(record), record, viewer };
  }

  async function stopAll(reason = 'hub_shutdown') {
    shuttingDown = true;
    await Promise.all([...streams.values()].map((record) => stop(record, reason)));
  }

  return {
    attachViewer,
    stop,
    stopAll,
    fail,
    get(key) { return publicRecord(streams.get(key)); },
    getRegistry() { return streams; },
    getActiveCount() { return streams.size; },
    getMetrics() { return { ...metrics, first_frame_latency: [...metrics.first_frame_latency], cast_duration: [...metrics.cast_duration] }; },
    isShuttingDown() { return shuttingDown; },
  };
}
