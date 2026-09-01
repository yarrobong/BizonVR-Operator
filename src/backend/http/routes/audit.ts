import { Router } from "express";
import { listAuditLogs } from "../../repositories/audit";
import type { RouteContext } from "./types";

export function createAuditRouter({ db, getActor }: RouteContext) {
  const router = Router();
  router.get("/audit-logs", (req, res) => res.json(listAuditLogs(db, getActor(req))));
  return router;
}
