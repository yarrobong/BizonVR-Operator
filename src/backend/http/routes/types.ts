import type { Request } from "express";
import type { SqliteDatabase, PermissionActor } from "../../db/types";

export type RouteContext = {
  db: SqliteDatabase;
  getActor: (req: Request) => PermissionActor;
  localHubStreamPort?: number;
  questAgentPackage?: string;
};
