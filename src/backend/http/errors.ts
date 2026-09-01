import type { Request, Response, NextFunction } from "express";

export class HttpError extends Error {
  constructor(public status: number, message: string, public nextStep?: string) {
    super(message);
  }
}
export function statusFromError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  if (error instanceof HttpError) return { status: error.status, body: { error: message, next_step: error.nextStep } };
  if (message.startsWith("Permission denied")) return { status: 403, body: { error: message, state: "permission_denied", next_step: "Ask an owner/admin to grant access for this club or action." } };
  if (message.startsWith("Subscription blocked")) return { status: 402, body: { error: message, state: "subscription_blocked", next_step: "Upgrade or reactivate the subscription before retrying." } };
  if (message.startsWith("Preflight failed")) return { status: 409, body: { error: message, state: "preflight_failed", next_step: "Fix the listed device readiness checks in Local Hub, then start again." } };
  if (message.includes("not attached") || message.includes("offline") || message.includes("active session") || message.includes("transition")) return { status: 409, body: { error: message, state: "command_failed", next_step: "Refresh device status and retry once Local Hub reports a healthy state." } };
  return { status: 400, body: { error: message } };
}

export function handleApiError(res: Response, error: unknown) {
  const result = statusFromError(error);
  return res.status(result.status).json(result.body);
}

export function apiErrorMiddleware(error: any, _req: Request, res: Response, next: NextFunction) {
  if (error?.type === "entity.too.large" || error?.status === 413) return res.status(413).json({ error: "Request body is too large", next_step: "Send only the bounded JSON control payload; APK files use the Local Hub artifact cache." });
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "Malformed JSON body" });
  return next(error);
}
