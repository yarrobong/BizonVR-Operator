#!/usr/bin/env node

// Real-session validation orchestrator. It uses the public Cloud API so every
// action travels through Cloud -> DeviceCommand -> Local Hub -> Quest Agent.
// It intentionally reports NOT RUN when no real API/device is configured.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const apiUrl = (process.env.SESSION_HARDWARE_API_URL || '').replace(/\/$/, '');
const deviceId = process.env.SESSION_HARDWARE_DEVICE_ID || '';
const appPackage = process.env.SESSION_HARDWARE_APP_PACKAGE || '';
const secondAppPackage = process.env.SESSION_HARDWARE_SECOND_APP_PACKAGE || '';
const output = path.resolve(process.env.SESSION_HARDWARE_OUTPUT || path.join('artifacts', 'session-soak', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const durationMinutes = Number(process.env.SESSION_HARDWARE_DURATION_MINUTES || 30);

function recordBase(result, reason) {
  return {
    schemaVersion: 1,
    result,
    hardwareValidation: result === 'not_run' ? 'not_run' : 'real_api_requested',
    generatedAt: new Date().toISOString(),
    target: { apiUrl: apiUrl || null, deviceId: deviceId || null, appPackage: appPackage || null },
    reason,
    scenarios: [],
    manualScenarios: ['browser refresh', 'Wi-Fi drop/restore', 'ADB reconnect', 'Local Hub restart', 'Quest reboot'],
  };
}

function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Session hardware soak: ${artifact.result.toUpperCase()}. Artifact: ${output}`);
}

async function request(method, route, body, headers = {}) {
  const response = await fetch(`${apiUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${payload.error || response.statusText}`);
  return payload;
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await request('GET', '/api/devices');
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for Cloud/Quest state convergence');
}

async function main() {
  if (!apiUrl || !deviceId || !appPackage || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    writeArtifact(recordBase('not_run', 'Set SESSION_HARDWARE_API_URL, SESSION_HARDWARE_DEVICE_ID and SESSION_HARDWARE_APP_PACKAGE to run against a real Quest.'));
    return 0;
  }
  const artifact = recordBase('incomplete', 'Real hardware run requested; manual fault scenarios must be recorded separately.');
  const startedAt = Date.now();
  try {
    const start = await request('POST', '/api/sessions/start', { device_id: Number(deviceId), app_package: appPackage, duration_minutes: durationMinutes });
    const sessionId = start.session_id;
    artifact.sessionId = sessionId;
    artifact.scenarios.push({ name: 'start', status: 'requested', sessionId });
    await waitFor((devices) => {
      const device = (Array.isArray(devices) ? devices : []).find((entry) => String(entry.id) === String(deviceId));
      return device?.active_session?.session_id === sessionId && ['running', 'paused'].includes(device.active_session.status);
    });

    const actions = [
      ['pause', `/api/sessions/${sessionId}/pause`, undefined],
      ['resume', `/api/sessions/${sessionId}/resume`, undefined],
      ['extend', `/api/sessions/${sessionId}/extend`, { minutes: 10 }],
    ];
    for (const [name, route, body] of actions) {
      const key = `hardware-soak-${sessionId}-${name}`;
      await request('POST', route, body, { 'Idempotency-Key': key });
      artifact.scenarios.push({ name, status: 'requested', idempotencyKey: key });
    }
    if (secondAppPackage) {
      await request('POST', `/api/sessions/${sessionId}/switch-app`, { app_package: secondAppPackage });
      artifact.scenarios.push({ name: 'switch-app', status: 'requested', appPackage: secondAppPackage });
    }
    await request('POST', `/api/sessions/${deviceId}/stop`, undefined, { 'Idempotency-Key': `hardware-soak-${sessionId}-end` });
    artifact.scenarios.push({ name: 'end', status: 'requested' });
    artifact.result = 'not_ready';
    artifact.reason = 'API orchestration completed; verify physical foreground/launcher, heartbeats and cleanup before calling this run PASS.';
  } catch (error) {
    artifact.result = 'failed';
    artifact.reason = error instanceof Error ? error.message : String(error);
  }
  artifact.run = { startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt };
  writeArtifact(artifact);
  return artifact.result === 'failed' ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
