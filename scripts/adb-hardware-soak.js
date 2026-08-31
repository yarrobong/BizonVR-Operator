#!/usr/bin/env node

// Non-production hardware validation harness. It deliberately talks to ADB
// through the same process runner and reconnect supervisor used by Local Hub,
// but does not start the Hub or mutate device/application state.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createAdbProcessRunner, isAdbTransportFailure } from '../local-hub/adb-process-runner.js';
import { createAdbSupervisor } from '../local-hub/adb-supervisor.js';
import { selectPreferredExecutionRoute } from '../local-hub/route-selection.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_HEALTH_COMMAND_INTERVAL_MS = 60 * 1000;
const DEFAULT_API_URL = process.env.ADB_SOAK_API_URL || null;

function usage() {
  return `Usage: node scripts/adb-hardware-soak.js --device <stable-id> [options]

Options:
  --device <id>                   Stable Quest identity (required)
  --duration <30m|2h|...>         Soak duration (default: 30m)
  --interval <5s|1000>             Probe interval (default: 5s)
  --health-command-interval <...>  Interval for shell echo BIZONVR_HEALTH (default: 60s)
  --api-url <url>                  Optional Bizon API URL for Agent heartbeat telemetry
  --json-output <path>             Artifact path (default: artifacts/adb-soak/<timestamp>.json)
  --adb-timeout <...>              Per-command timeout (default: 5s)
  --verbose                        Print every sample
  --help                           Show this help

Test/fake ADB mode is supported through ADB_PATH, ADB_PREFIX_ARGS (JSON array),
FAKE_ADB_STATE, and ADB_SOAK_SKIP_PORT_CHECK=1. No fake result is reported as
hardware validation.`;
}

function parseDuration(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000 }[String(match[2] || 'ms').toLowerCase()];
  return Math.max(0, Math.round(Number(match[1]) * multiplier));
}

function parseArgs(argv) {
  const options = {
    durationMs: DEFAULT_DURATION_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    healthCommandIntervalMs: DEFAULT_HEALTH_COMMAND_INTERVAL_MS,
    apiUrl: DEFAULT_API_URL,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value.`);
      index += 1;
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--verbose') { options.verbose = true; continue; }
    if (arg === '--device') { options.device = next(); continue; }
    if (arg === '--duration') { options.durationMs = parseDuration(next(), DEFAULT_DURATION_MS); continue; }
    if (arg === '--interval') { options.intervalMs = parseDuration(next(), DEFAULT_INTERVAL_MS); continue; }
    if (arg === '--health-command-interval') { options.healthCommandIntervalMs = parseDuration(next(), DEFAULT_HEALTH_COMMAND_INTERVAL_MS); continue; }
    if (arg === '--api-url') { options.apiUrl = next(); continue; }
    if (arg === '--json-output') { options.jsonOutput = next(); continue; }
    if (arg === '--adb-timeout') { options.adbTimeoutMs = parseDuration(next(), DEFAULT_TIMEOUT_MS); continue; }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.device) throw new Error('--device is required.');
  options.device = String(options.device).trim();
  if (!options.device) throw new Error('--device cannot be empty.');
  return options;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isWirelessSerial(serial) {
  return /^.+:\d+$/.test(String(serial || ''));
}

function parseDevices(stdout) {
  return String(stdout || '').split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, status, ...details] = line.split(/\s+/);
    return { serial, status, details: details.join(' ') };
  }).filter((entry) => entry.serial && entry.status);
}

function parseIpv4(stdout) {
  const match = String(stdout || '').match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\//);
  return match ? match[1] : null;
}

function errorMessage(error) {
  return String(error?.message || error?.stderr || error || 'Unknown error').trim();
}

function classifyError(error) {
  const message = errorMessage(error).toLowerCase();
  if (error?.timedOut || message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('unauthorized')) return 'unauthorized';
  if (message.includes('daemon') || message.includes('server')) return 'adb_server_unavailable';
  if (isAdbTransportFailure(error)) return 'transport_error';
  return 'command_error';
}

function percentile(values, percentileValue) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function latencySummary(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function createPortProbe() {
  return (host, port, timeoutMs = 1000) => new Promise((resolve) => {
    if (process.env.ADB_SOAK_SKIP_PORT_CHECK === '1') { resolve(true); return; }
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function normalizeApiUrl(value) {
  return value ? String(value).replace(/\/$/, '') : null;
}

async function readAgentTelemetry(apiUrl, stableSerial) {
  if (!apiUrl) return { status: 'unknown', heartbeatAgeMs: null, source: 'not_configured' };
  try {
    const response = await fetch(`${normalizeApiUrl(apiUrl)}/api/devices`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { status: 'unknown', heartbeatAgeMs: null, source: `http_${response.status}` };
    const payload = await response.json();
    const devices = Array.isArray(payload) ? payload : payload?.devices;
    const device = (devices || []).find((entry) => [entry.stable_id, entry.serial_number, entry.agent_id, entry.android_id].filter(Boolean).includes(stableSerial));
    if (!device) return { status: 'missing', heartbeatAgeMs: null, source: 'api_device_not_found' };
    const heartbeat = device.last_heartbeat_at || device.last_heartbeat || null;
    const parsedHeartbeat = heartbeat ? Date.parse(heartbeat) : NaN;
    return {
      status: device.agent_status || 'unknown',
      heartbeatAgeMs: Number.isFinite(parsedHeartbeat) ? Math.max(0, Date.now() - parsedHeartbeat) : null,
      heartbeatAt: heartbeat,
      source: 'api',
    };
  } catch (error) {
    return { status: 'unknown', heartbeatAgeMs: null, source: `api_error:${classifyError(error)}`, error: errorMessage(error) };
  }
}

function createHarness(options) {
  let prefixArgs = [];
  if (process.env.ADB_PREFIX_ARGS) {
    try { prefixArgs = JSON.parse(process.env.ADB_PREFIX_ARGS); } catch (error) { throw new Error(`ADB_PREFIX_ARGS must be a JSON array: ${errorMessage(error)}`); }
    if (!Array.isArray(prefixArgs)) throw new Error('ADB_PREFIX_ARGS must be a JSON array.');
  }
  const runner = createAdbProcessRunner({
    executable: process.env.ADB_PATH || 'adb',
    prefixArgs,
    defaultTimeoutMs: options.adbTimeoutMs || DEFAULT_TIMEOUT_MS,
  });
  const known = new Map();
  const records = [];
  const syntheticInput = Boolean(process.env.FAKE_ADB_STATE);
  const latencies = { getStateMs: [], healthCommandMs: [], reconnectMs: [] };
  const counters = {
    probes: 0,
    successfulProbes: 0,
    commandFailures: 0,
    timeouts: 0,
    unauthorized: 0,
    transportErrors: 0,
    routeChanges: 0,
    ipChanges: 0,
    reconnects: 0,
    reconnectSuccesses: 0,
    reconnectFailures: 0,
    maxConsecutiveFailures: 0,
  };
  let previousRoute = null;
  let previousIp = null;
  let consecutiveFailures = 0;
  let observedHardware = false;
  let lastReconnectKey = null;

  async function run(args, runOptions = {}) {
    return runner.run(args, { timeoutMs: options.adbTimeoutMs || DEFAULT_TIMEOUT_MS, ...runOptions });
  }

  async function safeCapture(args, runOptions = {}) {
    try {
      const result = await run(args, runOptions);
      if (!result.ok) {
        const error = new Error(errorMessage(result.stderr || `ADB exited with code ${result.code}`));
        Object.assign(error, result);
        throw error;
      }
      return { value: String(result.stdout || '').trim(), durationMs: result.durationMs, result };
    } catch (error) {
      return { error, durationMs: Number(error?.durationMs || 0), value: '' };
    }
  }

  async function listAdbDevices() {
    const result = await safeCapture(['devices', '-l']);
    if (result.error) throw result.error;
    return parseDevices(result.value);
  }

  async function inspectDevice(entry) {
    const inspection = { ...entry, stableSerial: entry.serial, androidId: null, ip: isWirelessSerial(entry.serial) ? entry.serial.split(':')[0] : null };
    if (entry.status !== 'device') return inspection;
    const [stable, android, ip] = await Promise.all([
      safeCapture(['-s', entry.serial, 'shell', 'getprop', 'ro.serialno']),
      safeCapture(['-s', entry.serial, 'shell', 'settings', 'get', 'secure', 'android_id']),
      safeCapture(['-s', entry.serial, 'shell', 'ip', 'addr', 'show', 'wlan0']),
    ]);
    inspection.stableSerial = stable.error ? entry.serial : (stable.value || entry.serial);
    inspection.androidId = android.error ? null : (android.value || null);
    inspection.ip = ip.error ? inspection.ip : (parseIpv4(ip.value) || inspection.ip);
    inspection.identityError = stable.error ? errorMessage(stable.error) : null;
    return inspection;
  }

  async function discoverTarget() {
    const entries = await listAdbDevices();
    const inspected = await Promise.all(entries.map(inspectDevice));
    const currentKnown = known.get(options.device) || {};
    const target = inspected.find((entry) => entry.stableSerial === options.device || entry.serial === options.device || entry.androidId === options.device);
    if (target) {
      observedHardware = true;
      const wireless = isWirelessSerial(target.serial);
      const next = {
        stableSerial: options.device,
        usbSerial: wireless ? currentKnown.usbSerial || null : target.serial,
        wirelessSerial: wireless ? target.serial : currentKnown.wirelessSerial || null,
        ip: target.ip || currentKnown.ip || null,
        androidId: target.androidId || currentKnown.androidId || null,
        previousIps: [...new Set([...(currentKnown.previousIps || []), target.ip, currentKnown.ip].filter(Boolean))].slice(-8),
        route: target.serial,
        adbState: target.status,
        agentOnline: null,
        entries: inspected.map(({ serial, status }) => ({ serial, status })),
      };
      known.set(options.device, next);
      return next;
    }
    return {
      stableSerial: options.device,
      usbSerial: currentKnown.usbSerial || null,
      wirelessSerial: currentKnown.wirelessSerial || null,
      ip: currentKnown.ip || null,
      androidId: currentKnown.androidId || null,
      previousIps: currentKnown.previousIps || [],
      route: null,
      adbState: 'offline',
      agentOnline: null,
      entries: inspected.map(({ serial, status }) => ({ serial, status })),
    };
  }

  async function verifyRouteIdentity({ serial, expectedStableId, expectedAndroidId }) {
    const stable = await safeCapture(['-s', serial, 'shell', 'getprop', 'ro.serialno']);
    const android = await safeCapture(['-s', serial, 'shell', 'settings', 'get', 'secure', 'android_id']);
    if (stable.error) return { matched: false, message: errorMessage(stable.error) };
    const stableId = stable.value || null;
    const androidId = android.error ? null : (android.value || null);
    if (expectedStableId && stableId !== expectedStableId) return { matched: false, stableId, androidId, message: `stable_id mismatch: expected ${expectedStableId}, got ${stableId || 'empty'}` };
    if (expectedAndroidId && androidId && androidId !== expectedAndroidId) return { matched: false, stableId, androidId, message: `android_id mismatch: expected ${expectedAndroidId}, got ${androidId}` };
    return { matched: true, stableId, androidId };
  }

  const supervisor = createAdbSupervisor({
    debounceMs: Math.max(0, Math.min(options.intervalMs, 5000)),
    baseBackoffMs: Math.max(100, Math.min(options.intervalMs, 5000)),
    maxBackoffMs: 30000,
    log: (_scope, message, detail) => options.verbose && console.log(`[supervisor] ${message}`, detail || ''),
    getKnownState: (stableSerial) => known.get(stableSerial) || {},
    rememberRoute: (stableSerial, updates) => {
      const current = known.get(stableSerial) || {};
      known.set(stableSerial, { ...current, ...updates, previousIps: [...new Set([...(current.previousIps || []), updates.ip].filter(Boolean))].slice(-8) });
    },
    checkRoutePortOpen: createPortProbe(),
    adbDisconnect: async (serial) => {
      const result = await run(['disconnect', serial]);
      return { success: result.ok, message: result.stderr || result.stdout };
    },
    adbConnect: async (serial) => {
      const result = await run(['connect', serial]);
      return { success: result.ok, message: result.stderr || result.stdout };
    },
    verifyRouteIdentity,
    checkAdbRecoveryPermission: () => ({ allowed: false, status: 'not_requested', message: 'Soak harness does not enable wireless ADB.' }),
  });

  async function sample(sampleNumber, startedAt) {
    const timestamp = isoNow();
    let discovered;
    let discoveryError = null;
    try { discovered = await discoverTarget(); } catch (error) { discoveryError = error; discovered = { stableSerial: options.device, adbState: 'offline', entries: [] }; }
    const telemetry = await readAgentTelemetry(options.apiUrl, options.device);
    discovered.agentOnline = telemetry.status === 'online' ? true : telemetry.status === 'offline' ? false : null;
    discovered.heartbeatAgeMs = telemetry.heartbeatAgeMs;
    discovered.agentStatus = telemetry.status;
    discovered.telemetrySource = telemetry.source;

    const supervisorState = await supervisor.tick({
      ...discovered,
      stableSerial: options.device,
      // The supervisor consumes the normalized route state used by Local Hub.
      // `adb devices` uses the literal status `device` for the same condition.
      adbState: discovered.adbState === 'device' ? 'online' : discovered.adbState,
    }, { heartbeatIp: discovered.ip, reason: 'hardware_soak' });
    const liveState = supervisor.getState(options.device) || supervisorState || null;
    const executionRoute = selectPreferredExecutionRoute({
      usbOnline: discovered.usbSerial && discovered.route === discovered.usbSerial && discovered.adbState === 'device',
      usbSerial: discovered.usbSerial,
      wirelessOnline: discovered.wirelessSerial && discovered.route === discovered.wirelessSerial && discovered.adbState === 'device',
      wirelessSerial: discovered.wirelessSerial,
    }, { purpose: 'control' }) || discovered.route || null;
    if (executionRoute) observedHardware = true;

    const sampleRecord = {
      sample: sampleNumber,
      timestamp,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      stableSerial: options.device,
      executionRoute,
      ip: discovered.ip || null,
      agentStatus: discovered.agentStatus,
      agentOnline: discovered.agentOnline,
      heartbeatAgeMs: discovered.heartbeatAgeMs,
      adbStatus: discovered.adbState === 'device' ? 'online' : discovered.adbState,
      getStateLatencyMs: null,
      healthCommandLatencyMs: null,
      healthCommand: null,
      reconnect: liveState?.lastReconnect || null,
      reconnectState: liveState?.status || 'idle',
      reconnectMetrics: liveState?.metrics || supervisor.getMetrics(options.device),
      routeCandidates: liveState?.candidates || [],
      entries: discovered.entries || [],
      consecutiveFailures,
      errors: [],
    };
    if (discoveryError) sampleRecord.errors.push({ operation: 'devices', category: classifyError(discoveryError), message: errorMessage(discoveryError) });

    if (executionRoute) {
      const stateProbe = await safeCapture(['-s', executionRoute, 'get-state']);
      sampleRecord.getStateLatencyMs = stateProbe.durationMs;
      if (stateProbe.durationMs) latencies.getStateMs.push(stateProbe.durationMs);
      counters.probes += 1;
      if (!stateProbe.error && stateProbe.value === 'device') {
        counters.successfulProbes += 1;
        consecutiveFailures = 0;
        sampleRecord.adbStatus = 'online';
      } else {
        consecutiveFailures += 1;
        counters.commandFailures += 1;
        const error = stateProbe.error || new Error(`get-state returned ${stateProbe.value || 'empty'}`);
        const category = classifyError(error);
        if (category === 'timeout') counters.timeouts += 1;
        if (category === 'unauthorized') counters.unauthorized += 1;
        if (category === 'transport_error') counters.transportErrors += 1;
        sampleRecord.adbStatus = category === 'unauthorized' ? 'unauthorized' : 'offline';
        sampleRecord.errors.push({ operation: 'get-state', category, message: errorMessage(error) });
      }
      if (sampleNumber === 1 || Date.now() - (records.at(-1)?.healthCommandAtMs || 0) >= options.healthCommandIntervalMs) {
        const health = await safeCapture(['-s', executionRoute, 'shell', 'echo', 'BIZONVR_HEALTH']);
        sampleRecord.healthCommandLatencyMs = health.durationMs;
        sampleRecord.healthCommandAtMs = Date.now();
        sampleRecord.healthCommand = health.error ? 'failed' : health.value === 'BIZONVR_HEALTH' ? 'ok' : 'unexpected_output';
        if (health.durationMs) latencies.healthCommandMs.push(health.durationMs);
        if (health.error || health.value !== 'BIZONVR_HEALTH') {
          counters.commandFailures += 1;
          const error = health.error || new Error(`health command returned ${health.value || 'empty'}`);
          const category = classifyError(error);
          if (category === 'timeout') counters.timeouts += 1;
          if (category === 'transport_error') counters.transportErrors += 1;
          sampleRecord.errors.push({ operation: 'health-command', category, message: errorMessage(error) });
        }
      }
    } else {
      consecutiveFailures += 1;
      sampleRecord.errors.push({ operation: 'route-selection', category: 'device_not_found', message: `No ADB route found for ${options.device}.` });
    }
    sampleRecord.consecutiveFailures = consecutiveFailures;
    counters.maxConsecutiveFailures = Math.max(counters.maxConsecutiveFailures, consecutiveFailures);
    const reconnect = sampleRecord.reconnect;
    if (reconnect) {
      const reconnectKey = `${reconnect.generation}:${reconnect.result}:${reconnect.elapsedMs}`;
      if (reconnectKey !== lastReconnectKey) {
        lastReconnectKey = reconnectKey;
        counters.reconnects += 1;
        if (reconnect.result === 'success') { counters.reconnectSuccesses += 1; latencies.reconnectMs.push(reconnect.elapsedMs); }
        else counters.reconnectFailures += 1;
      }
    }
    if (previousRoute && executionRoute && previousRoute !== executionRoute) counters.routeChanges += 1;
    if (previousIp && discovered.ip && previousIp !== discovered.ip) counters.ipChanges += 1;
    previousRoute = executionRoute || previousRoute;
    previousIp = discovered.ip || previousIp;
    records.push(sampleRecord);
    if (options.verbose) console.log(`[${timestamp}] route=${executionRoute || 'none'} ip=${discovered.ip || 'none'} adb=${sampleRecord.adbStatus} agent=${sampleRecord.agentStatus} get-state=${sampleRecord.getStateLatencyMs ?? '-'}ms failures=${consecutiveFailures}`);
    return sampleRecord;
  }

  function makeArtifact({ startedAt, endedAt, result, stopReason }) {
    const automatedResult = result;
    return {
      schemaVersion: 1,
      result: syntheticInput || !observedHardware ? 'not_run' : result,
      automatedResult,
      hardwareValidation: syntheticInput ? 'not_run_fake_adb' : (!observedHardware ? 'not_run_no_device' : 'real_device_observed'),
      stopReason,
      generatedAt: isoNow(),
      target: { stableSerial: options.device, apiUrl: options.apiUrl, adbExecutable: process.env.ADB_PATH || 'adb', syntheticInput },
      configuration: { durationMs: options.durationMs, intervalMs: options.intervalMs, healthCommandIntervalMs: options.healthCommandIntervalMs, adbTimeoutMs: options.adbTimeoutMs || DEFAULT_TIMEOUT_MS },
      run: { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), elapsedMs: Math.max(0, endedAt - startedAt), samples: records.length, hardwareObserved: observedHardware },
      counters: { ...counters },
      availability: counters.probes ? counters.successfulProbes / counters.probes : null,
      latency: { getState: latencySummary(latencies.getStateMs), healthCommand: latencySummary(latencies.healthCommandMs), reconnect: latencySummary(latencies.reconnectMs) },
      reconnect: supervisor.getState(options.device)?.lastReconnect || null,
      samples: records,
      limitations: [
        options.apiUrl ? null : 'Agent heartbeat status and heartbeat age are unknown because --api-url was not configured.',
        'This harness validates ADB transport and the existing recovery supervisor; it does not emulate Wi-Fi/router/power events.',
        'A passing soak is evidence for the observed device and scenario only, not a blanket hardware readiness claim.',
      ].filter(Boolean),
    };
  }

  return { sample, makeArtifact, records, counters, get observedHardware() { return observedHardware; } };
}

function makeSummary(artifact) {
  const status = artifact.result === 'not_run'
    ? (artifact.hardwareValidation === 'not_run_fake_adb' ? 'NOT RUN (fake/test ADB)' : 'NOT RUN')
    : artifact.result === 'pass' ? 'PASS (ADB soak only)' : 'NOT READY';
  const lines = [
    `BizonVR ADB hardware soak: ${status}`,
    `Target: ${artifact.target.stableSerial}`,
    `Run: ${artifact.run.startedAt} -> ${artifact.run.endedAt} (${artifact.run.elapsedMs} ms), samples=${artifact.run.samples}`,
    `Availability: ${artifact.availability === null ? 'n/a' : `${(artifact.availability * 100).toFixed(2)}%`} (${artifact.counters.successfulProbes}/${artifact.counters.probes} get-state probes)`,
    `Latency get-state: p50=${artifact.latency.getState.p50Ms ?? 'n/a'}ms p95=${artifact.latency.getState.p95Ms ?? 'n/a'}ms p99=${artifact.latency.getState.p99Ms ?? 'n/a'}ms`,
    `Latency health command: p50=${artifact.latency.healthCommand.p50Ms ?? 'n/a'}ms p95=${artifact.latency.healthCommand.p95Ms ?? 'n/a'}ms`,
    `Reconnects: ${artifact.counters.reconnects} total, ${artifact.counters.reconnectSuccesses} successful, ${artifact.counters.reconnectFailures} failed; p95=${artifact.latency.reconnect.p95Ms ?? 'n/a'}ms`,
    `Route changes: ${artifact.counters.routeChanges}; IP changes: ${artifact.counters.ipChanges}; timeouts: ${artifact.counters.timeouts}; unauthorized: ${artifact.counters.unauthorized}; transport errors: ${artifact.counters.transportErrors}`,
    `Max consecutive failures: ${artifact.counters.maxConsecutiveFailures}`,
    `Stop reason: ${artifact.stopReason}; automated result=${artifact.automatedResult}`,
  ];
  for (const limitation of artifact.limitations) lines.push(`Limitation: ${limitation}`);
  return lines.join('\n');
}

async function writeArtifacts(options, artifact) {
  const defaultPath = path.resolve('artifacts', 'adb-soak', `${timestampForPath(new Date(artifact.run.startedAt))}.json`);
  const jsonPath = path.resolve(options.jsonOutput || defaultPath);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const summaryPath = jsonPath.replace(/\.json$/i, '.summary.txt');
  fs.writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(summaryPath, `${makeSummary(artifact)}\n`);
  return { jsonPath, summaryPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  const harness = createHarness(options);
  const startedAt = Date.now();
  const deadline = startedAt + options.durationMs;
  let stopReason = 'duration_elapsed';
  let sampleNumber = 0;
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    do {
      sampleNumber += 1;
      await harness.sample(sampleNumber, startedAt);
      if (!harness.observedHardware && sampleNumber === 1) { stopReason = 'no_adb_device_found'; break; }
      if (interrupted) { stopReason = 'interrupted'; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(options.intervalMs, remaining));
    } while (Date.now() < deadline && !interrupted);
    if (interrupted && stopReason === 'duration_elapsed') stopReason = 'interrupted';
    const endedAt = Date.now();
    const artifact = harness.makeArtifact({ startedAt, endedAt, stopReason, result: !harness.observedHardware ? 'not_run' : (harness.counters.commandFailures === 0 && harness.counters.reconnectFailures === 0 ? 'pass' : 'not_ready') });
    const paths = await writeArtifacts(options, artifact);
    console.log(makeSummary(artifact));
    console.log(`JSON artifact: ${paths.jsonPath}`);
    console.log(`Human summary: ${paths.summaryPath}`);
    return 0;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`ADB soak failed: ${errorMessage(error)}`);
  console.error(usage());
  process.exitCode = 1;
});
