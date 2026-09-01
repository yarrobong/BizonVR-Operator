import crypto from "crypto";

const COMMAND_POLICIES: Record<string, { maxAttempts: number; retryable: boolean; reconciliable: boolean; dangerous: boolean }> = {
  PING: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  REFRESH_STATUS: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  RUN_DIAGNOSTICS: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  OPEN_LAUNCHER: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  LAUNCH_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: false },
  STOP_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: false },
  OPEN_SCRCPY: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  CLOSE_SCRCPY: { maxAttempts: 2, retryable: true, reconciliable: true, dangerous: false },
  RECONNECT_ADB: { maxAttempts: 3, retryable: true, reconciliable: false, dangerous: false },
  INSTALL_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  INSTALL_APK: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  UNINSTALL_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  START_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  PAUSE_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  RESUME_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  EXTEND_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  SWITCH_SESSION_APP: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  END_SESSION: { maxAttempts: 1, retryable: false, reconciliable: true, dangerous: true },
  FORGET_DEVICE: { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true },
  REBOOT_DEVICE: { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true },
};

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}
export function canonicalCommandPayload(payload: Record<string, unknown> | string | null | undefined) {
  let parsed: unknown = payload ?? {};
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed || "{}"); } catch { parsed = {}; }
  }
  return JSON.stringify(canonicalizeJson(parsed || {}));
}

export function commandPayloadHash(payload: Record<string, unknown> | string | null | undefined) {
  return crypto.createHash("sha256").update(canonicalCommandPayload(payload)).digest("hex");
}

export function getCommandPolicy(type: string) {
  return COMMAND_POLICIES[type] ?? { maxAttempts: 1, retryable: false, reconciliable: false, dangerous: true };
}
