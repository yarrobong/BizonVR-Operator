#!/usr/bin/env node

// Real-device-only casting validation. This script never reports PASS unless
// the requested Quest is observed through a real adb get-state probe.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createAdbProcessRunner } from '../local-hub/adb-process-runner.js';

const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5000;

function parseDuration(value, fallback) {
  if (value == null || value === '') return fallback;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Math.max(0, Math.round(Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[String(match[2] || 'ms').toLowerCase()] || 1)));
}

function parseArgs(argv) {
  const options = { durationMs: DEFAULT_DURATION_MS, intervalMs: DEFAULT_INTERVAL_MS, profile: 'low-latency', apiUrl: null, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--device') options.device = next();
    else if (arg === '--duration') options.durationMs = parseDuration(next(), DEFAULT_DURATION_MS);
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--interval') options.intervalMs = parseDuration(next(), DEFAULT_INTERVAL_MS);
    else if (arg === '--api-url') options.apiUrl = next();
    else if (arg === '--output') options.output = next();
    else if (arg === '--verbose') options.verbose = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.device) throw new Error('--device is required.');
  return options;
}

function usage() {
  return `Usage: node scripts/cast-hardware-soak.js --device <adb-route> [options]

Options:
  --device <route>       Verified USB or Wi-Fi ADB route (required)
  --duration <30m|2h>    Soak duration (default: 30m)
  --profile <name>       Cast profile (default: low-latency)
  --interval <5s>        Restart interval (default: 5s)
  --api-url <url>        Local Hub URL, for example http://192.168.1.10:3001
  --output <path>        JSON artifact path (default: artifacts/cast-soak/<timestamp>.json)
  --verbose              Print every sample

The harness is real-hardware-only. Missing adb/device results in NOT RUN.`;
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function probeDevice(runner, device) {
  const result = await runner.run(['-s', device, 'get-state']);
  return { online: result.ok && result.stdout.trim() === 'device', result };
}

async function readOneStream(apiUrl, device, profile) {
  if (!apiUrl) return { status: 'not_configured', firstByteMs: null, bytes: 0 };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `${String(apiUrl).replace(/\/$/, '')}/streams/${encodeURIComponent(device)}?transport=fmp4&profile=${encodeURIComponent(profile)}&soak=${startedAt}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) return { status: `http_${response.status}`, firstByteMs: null, bytes: 0 };
    const reader = response.body.getReader();
    const first = await reader.read();
    const bytes = first.value?.byteLength || 0;
    await reader.cancel();
    return { status: bytes > 0 ? 'ok' : 'empty', firstByteMs: bytes > 0 ? Date.now() - startedAt : null, bytes };
  } catch (error) {
    return { status: error?.name === 'AbortError' ? 'timeout' : 'request_error', firstByteMs: null, bytes: 0, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  const runner = createAdbProcessRunner({ executable: process.env.ADB_PATH || 'adb', defaultTimeoutMs: 5000 });
  const startedAt = Date.now();
  const samples = [];
  const counters = { probes: 0, onlineProbes: 0, streamAttempts: 0, streamSuccesses: 0, streamFailures: 0, totalBytes: 0, restarts: 0 };
  const firstFrameLatencies = [];
  const firstProbe = await probeDevice(runner, options.device);
  if (!firstProbe.online) {
    const artifact = { result: 'not_run', hardwareValidation: 'not_run_no_device', target: options.device, generatedAt: new Date().toISOString(), reason: firstProbe.result.spawnError?.message || firstProbe.result.stderr || 'ADB route is not online', counters, samples };
    const output = path.resolve(options.output || path.join('artifacts', 'cast-soak', `${timestamp()}.json`));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`Cast hardware soak: NOT RUN (Quest not available). Artifact: ${output}`);
    return 0;
  }
  const deadline = startedAt + options.durationMs;
  while (Date.now() < deadline) {
    counters.probes += 1;
    const probe = await probeDevice(runner, options.device);
    if (probe.online) counters.onlineProbes += 1;
    counters.streamAttempts += 1;
    const stream = probe.online ? await readOneStream(options.apiUrl, options.device, options.profile) : { status: 'adb_offline', firstByteMs: null, bytes: 0 };
    if (stream.status === 'ok') { counters.streamSuccesses += 1; counters.totalBytes += stream.bytes; if (stream.firstByteMs != null) firstFrameLatencies.push(stream.firstByteMs); }
    else counters.streamFailures += 1;
    counters.restarts += 1;
    const sample = { at: new Date().toISOString(), adb: probe.online ? 'online' : 'offline', stream, elapsedMs: Date.now() - startedAt };
    samples.push(sample);
    if (options.verbose) console.log(`[${sample.at}] adb=${sample.adb} stream=${stream.status} firstFrame=${stream.firstByteMs ?? '-'}ms bytes=${stream.bytes}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(options.intervalMs, remaining));
  }
  const artifact = {
    schemaVersion: 1,
    result: counters.streamFailures === 0 ? 'pass' : 'not_ready',
    hardwareValidation: 'real_device_observed',
    generatedAt: new Date().toISOString(),
    target: { device: options.device, apiUrl: options.apiUrl, profile: options.profile },
    run: { startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt },
    counters,
    firstFrameLatencyMs: { count: firstFrameLatencies.length, p95: firstFrameLatencies.length ? firstFrameLatencies.sort((a, b) => a - b)[Math.min(firstFrameLatencies.length - 1, Math.ceil(firstFrameLatencies.length * 0.95) - 1)] : null },
    samples,
    limitations: ['This is an observed Quest/Local Hub soak, not a blanket hardware readiness claim.', 'ADB/network/power fault injection still requires a controlled club-network test.'],
  };
  const output = path.resolve(options.output || path.join('artifacts', 'cast-soak', `${timestamp()}.json`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Cast hardware soak: ${artifact.result.toUpperCase()} (real device observed). Artifact: ${output}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); console.error(usage()); process.exitCode = 1; });
