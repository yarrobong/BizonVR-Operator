import { Router } from "express";
import { listClubs, listRooms } from "../../repositories/clubs";
import { listLocalHubs } from "../../repositories/hubs";
import type { RouteContext } from "./types";

export function createCatalogRouter({ db, getActor }: RouteContext) {
  const router = Router();
  router.get("/clubs", (req, res) => res.json(listClubs(db, getActor(req))));
  router.get("/branches", (req, res) => res.json(listClubs(db, getActor(req)).map((club: any) => ({ id: club.id, club_id: club.id, name: club.name, organization_id: club.organization_id, status: club.status, timezone: club.timezone }))));
  router.get("/rooms", (req, res) => res.json(listRooms(db, getActor(req))));
  router.get("/hubs", (req, res) => res.json(listLocalHubs(db, getActor(req))));
  return router;
}
