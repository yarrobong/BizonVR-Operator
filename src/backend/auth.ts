import crypto from "node:crypto";

const TOKEN_VERSION = "bizonvr-v1";
const DEFAULT_TOKEN_TTL_SECONDS = 8 * 60 * 60;

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(input: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(input).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createWebAuthToken(
  userId: number,
  secret = process.env.AUTH_SECRET || "",
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
) {
  if (!secret) throw new Error("AUTH_SECRET is required to create an authentication token");
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("A valid user id is required");
  const payload = encode(JSON.stringify({ sub: userId, iat: nowSeconds, exp: nowSeconds + ttlSeconds }));
  return `${TOKEN_VERSION}.${payload}.${sign(`${TOKEN_VERSION}.${payload}`, secret)}`;
}

export function verifyWebAuthToken(
  authorization: string | null | undefined,
  secret = process.env.AUTH_SECRET || "",
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!secret || typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
  if (!match) return null;
  const [version, encodedPayload, providedSignature] = match[1].split(".");
  if (version !== TOKEN_VERSION || !safeEqual(providedSignature, sign(`${version}.${encodedPayload}`, secret))) return null;

  try {
    const payload = JSON.parse(decode(encodedPayload)) as { sub?: unknown; iat?: unknown; exp?: unknown };
    const userId = Number(payload.sub);
    const issuedAt = Number(payload.iat);
    const expiresAt = Number(payload.exp);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return null;
    if (issuedAt > nowSeconds + 60 || expiresAt <= nowSeconds || expiresAt - issuedAt > DEFAULT_TOKEN_TTL_SECONDS * 2) return null;
    return { userId, issuedAt, expiresAt };
  } catch {
    return null;
  }
}

export function constantTimeEqualSecret(actual: string | null | undefined, expected: string | null | undefined) {
  if (!actual || !expected) return false;
  return safeEqual(actual, expected);
}
