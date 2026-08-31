export type AdbProcessResult = {
  ok: boolean;
  command: string;
  args: string[];
  stdout: string | Buffer;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: unknown;
  outputLimitExceeded: boolean;
  errorCode: string | null;
  durationMs: number;
};

export function createAdbProcessRunner(options?: {
  executable?: string;
  prefixArgs?: string[];
  defaultTimeoutMs?: number;
  killGraceMs?: number;
}): {
  run(args: Array<string | number>, options?: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number; encoding?: "buffer"; signal?: AbortSignal; spawnOptions?: Record<string, unknown> }): Promise<AdbProcessResult>;
  capture(args: Array<string | number>, options?: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number; encoding?: "buffer"; signal?: AbortSignal; spawnOptions?: Record<string, unknown> }): Promise<string | Buffer>;
  getActiveCount(): number;
};

export class AdbProcessError extends Error {
  timedOut: boolean;
  spawnError: unknown;
  result: AdbProcessResult;
}

export function isAdbTransportFailure(error: unknown): boolean;
