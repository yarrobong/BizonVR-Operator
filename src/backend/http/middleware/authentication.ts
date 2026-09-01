import type { NextFunction, Request, Response } from "express";
import type { SqliteDatabase, PermissionActor } from "../../db/types";
import { getPermissionActor } from "../../services/authorization";
import { constantTimeEqualSecret, verifyWebAuthToken } from "../../auth";
import { HttpError, handleApiError } from "../errors";

export type RequestWithAuth = Request & { actor?: PermissionActor | null };
const PRODUCTION_AUTH_SECRET_MINIMUM_LENGTH = 32;

function expectedHubToken(hubId: number) {
  if (process.env.HUB_TOKENS_JSON) {
    try {
      const tokens = JSON.parse(process.env.HUB_TOKENS_JSON) as Record<string, string>;
      const token = tokens[String(hubId)];
      if (token !== undefined && typeof token !== "string") throw new Error("Hub token must be a string");
      return token || null;
    } catch {
      throw new HttpError(503, "Invalid HUB_TOKENS_JSON configuration");
    }
  }
  return process.env.HUB_TOKEN || null;
}
export function getRequestActor(req: Request, db: SqliteDatabase) {
  const authenticatedActor = (req as RequestWithAuth).actor;
  if (authenticatedActor) return authenticatedActor;
  const allowDevFallback = process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_AUTH_FALLBACK === "1";
  const headerUserId = allowDevFallback ? req.header("x-user-id") : null;
  const actor = headerUserId ? getPermissionActor(db, Number(headerUserId)) : null;
  if (!actor) throw new HttpError(401, "Authentication required", "Sign in as an active club user before performing this action.");
  return actor;
}

export function assertHubRequest(req: Request, hubId: number) {
  const authorization = req.header("authorization") || "";
  const expectedToken = expectedHubToken(hubId);
  if (process.env.HUB_TOKENS_JSON && !expectedToken) throw new HttpError(401, "No credentials are configured for this Local Hub");
  const allowDevHubFallback = process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_HUB_AUTH_FALLBACK === "1";
  if (!expectedToken && !allowDevHubFallback) throw new HttpError(503, "Local Hub authentication is not configured", "Set a per-hub token before enabling Local Hub command sync.");
  const presentedToken = /^Bearer (.+)$/.exec(authorization.trim())?.[1] || "";
  if (expectedToken && !constantTimeEqualSecret(presentedToken, expectedToken)) throw new HttpError(401, "Invalid Local Hub credentials", "Reconnect this Local Hub with the configured Hub token.");
  if (!Number.isInteger(hubId) || hubId <= 0) throw new HttpError(400, "Invalid Local Hub id");
}

function authenticateApiRequest(req: Request, db: SqliteDatabase) {
  if (process.env.NODE_ENV === "production" && (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < PRODUCTION_AUTH_SECRET_MINIMUM_LENGTH)) {
    throw new HttpError(503, "Web API authentication is not configured", "Set AUTH_SECRET to a random value of at least 32 characters before enabling production");
  }
  const verified = verifyWebAuthToken(req.header("authorization"), process.env.AUTH_SECRET);
  if (verified) {
    const actor = getPermissionActor(db, verified.userId);
    if (!actor) throw new HttpError(401, "Authentication required", "The account is inactive or no longer has club membership.");
    (req as RequestWithAuth).actor = actor;
    return;
  }
  const allowDevFallback = process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_AUTH_FALLBACK === "1";
  if (allowDevFallback) {
    const fallbackActor = getPermissionActor(db, Number(req.header("x-user-id")));
    if (fallbackActor) {
      (req as RequestWithAuth).actor = fallbackActor;
      return;
    }
  }
  throw new HttpError(401, "Authentication required", "Send a valid signed Bearer token for an active club user.");
}

export function apiAuthenticationMiddleware(db: SqliteDatabase) {
  return (req: Request, res: Response, next: NextFunction) => {
    const isHubTransport = req.path === "/hub/call_operator" || /^\/hubs\/\d+\/sync$/.test(req.path) || /^\/commands\/\d+\/status$/.test(req.path);
    if (req.path === "/health" || req.path === "/agent/heartbeat" || req.path === "/agent/call_operator" || isHubTransport) return next();
    if (req.path === "/devices" && req.header("x-hub-id")) {
      try { assertHubRequest(req, Number(req.header("x-hub-id"))); return next(); } catch (error) { return handleApiError(res, error); }
    }
    try { authenticateApiRequest(req, db); return next(); } catch (error) { return handleApiError(res, error); }
  };
}
