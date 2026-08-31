import { spawn } from 'node:child_process';

export class AdbProcessError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'AdbProcessError';
    this.code = result?.code ?? null;
    this.signal = result?.signal ?? null;
    this.timedOut = Boolean(result?.timedOut);
    this.spawnError = result?.spawnError ?? null;
    this.stdout = result?.stdout || '';
    this.stderr = result?.stderr || '';
    this.result = result;
  }
}

function killProcess(child, signal) {
  if (!child || child.exitCode !== null || child.killed) return false;
  try {
    // A detached child is its own process group on POSIX. Killing the group
    // prevents adb descendants from surviving a timed-out command.
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeByteLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function createAdbProcessRunner({
  executable = process.env.ADB_PATH || 'adb',
  prefixArgs = [],
  defaultTimeoutMs = 5000,
  killGraceMs = 250,
  spawnImpl = spawn,
  now = () => Date.now(),
} = {}) {
  const active = new Set();

  function run(args = [], options = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' && typeof arg !== 'number')) {
      return Promise.reject(new TypeError('ADB argv must be an array of strings or numbers.'));
    }

    const timeoutMs = Number(options.timeoutMs ?? defaultTimeoutMs);
    const command = String(options.executable || executable);
    const argv = args.map(String);
    const childArgs = [...prefixArgs.map(String), ...argv];

    return new Promise((resolve) => {
      const startedAt = now();
      let child;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let killTimer = null;
      let timeoutTimer = null;
      const binaryOutput = options.encoding === 'buffer';
      let stdout = binaryOutput ? Buffer.alloc(0) : '';
      let stderr = '';
      const maxStdoutBytes = normalizeByteLimit(options.maxStdoutBytes ?? (binaryOutput ? 8 * 1024 * 1024 : 1024 * 1024), binaryOutput ? 8 * 1024 * 1024 : 1024 * 1024);
      const maxStderrBytes = normalizeByteLimit(options.maxStderrBytes ?? 256 * 1024, 256 * 1024);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimitExceeded = false;
      let onAbort = () => {};

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener?.('abort', onAbort);
        if (child) active.delete(child);
        resolve({
          ok: !result.spawnError && !result.timedOut && !outputLimitExceeded && result.code === 0,
          command,
          args: argv,
          stdout,
          stderr,
          code: result.code ?? null,
          signal: result.signal ?? null,
          timedOut: Boolean(result.timedOut),
          cancelled,
          spawnError: result.spawnError || null,
          outputLimitExceeded,
          errorCode: outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : null,
          durationMs: Math.max(0, now() - startedAt),
        });
      };

      onAbort = () => {
        if (settled) return;
        cancelled = true;
        killProcess(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) killProcess(child, 'SIGKILL');
        }, killGraceMs);
      };

      const stopForOutputLimit = () => {
        if (outputLimitExceeded || settled) return;
        outputLimitExceeded = true;
        killProcess(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) killProcess(child, 'SIGKILL');
        }, killGraceMs);
      };

      try {
        child = spawnImpl(command, childArgs, {
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...options.spawnOptions,
        });
        active.add(child);
      } catch (error) {
        finish({ spawnError: error });
        return;
      }

      if (options.signal?.aborted) {
        onAbort();
      } else {
        options.signal?.addEventListener?.('abort', onAbort, { once: true });
      }

      if (!binaryOutput) child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxStdoutBytes) return stopForOutputLimit();
        stdout = binaryOutput ? Buffer.concat([stdout, Buffer.from(chunk)]) : stdout + chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > maxStderrBytes) return stopForOutputLimit();
        stderr += chunk;
      });
      child.once('error', (error) => finish({ spawnError: error, timedOut }));
      child.once('close', (code, signal) => finish({ code, signal, timedOut }));

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcess(child, 'SIGTERM');
          killTimer = setTimeout(() => {
            if (!settled) killProcess(child, 'SIGKILL');
          }, killGraceMs);
        }, timeoutMs);
        timeoutTimer.unref?.();
      }
    });
  }

  async function capture(args, options = {}) {
    const result = await run(args, options);
    if (!result.ok) {
      const reason = result.timedOut
        ? `ADB command timed out after ${options.timeoutMs ?? defaultTimeoutMs}ms.`
        : result.outputLimitExceeded
          ? 'ADB process output exceeded the configured safety limit.'
        : result.spawnError
          ? `ADB process could not start: ${result.spawnError.message || result.spawnError}`
          : `ADB exited with code ${result.code ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim()}` : ''}`;
      throw new AdbProcessError(reason, result);
    }
    return result.stdout;
  }

  return {
    run,
    capture,
    getActiveCount: () => active.size,
  };
}

export function isAdbTransportFailure(error) {
  if (!error) return false;
  if (error.timedOut || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') return true;
  const message = String(error.message || error.stderr || error);
  return /offline|no devices|device not found|cannot connect|connection refused|transport|daemon|closed|timed out/i.test(message);
}
