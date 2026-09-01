export function formatSqliteTimestamp(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
export function parseSqliteTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseJsonObject(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value: string | null | undefined) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    /(token|secret|password|credential|private[_-]?key)/i.test(key)
      ? [key, "[REDACTED]"]
      : [key, redactSecrets(item)]));
}

export function assertNoRawCredentialFields(value: unknown, location = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawCredentialFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "rotate_agent_credential" && item === true) continue;
    if (/(?:agent[_-]?token|token)[_-]?hash$/i.test(key)) {
      if (typeof item === "string" && /^[a-f0-9]{64}$/i.test(item)) continue;
      throw new Error(`Agent credential hash must be valid SHA-256 in ${location}: ${key}`);
    }
    if (/(?:token|credential|secret|password|private[_-]?key)$/i.test(key)) {
      throw new Error(`Raw credential field is not accepted in ${location}: ${key}`);
    }
    assertNoRawCredentialFields(item, `${location}.${key}`);
  }
}

export function redactLegacyRawCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLegacyRawCredentialFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    /(?:token|credential|secret|password|private[_-]?key)$/i.test(key)
      ? [key, "[REDACTED]"]
      : [key, redactLegacyRawCredentialFields(item)]));
}
