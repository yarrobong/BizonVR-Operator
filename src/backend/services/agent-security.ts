import crypto from "crypto";
import type { SqliteDatabase } from "../db/types";

export function verifyAgentCredential(
  db: SqliteDatabase,
  identity: { pairingId?: string | null; agentId?: string | null; stableId?: string | null; androidId?: string | null },
  token: string,
) {
  if (!token || typeof token !== "string") return null;
  const candidates = [identity.pairingId, identity.agentId, identity.stableId, identity.androidId].filter(Boolean) as string[];
  if (candidates.length === 0) return null;
  const placeholders = candidates.map(() => "?").join(",");
  const device = db.prepare(`SELECT id, club_id, local_hub_id, pairing_id, agent_id, stable_id, android_id, agent_token_hash FROM devices WHERE pairing_id IN (${placeholders}) OR agent_id IN (${placeholders}) OR stable_id IN (${placeholders}) OR android_id IN (${placeholders}) LIMIT 1`).get(...candidates, ...candidates, ...candidates, ...candidates) as
    | { id: number; club_id: number; local_hub_id: number | null; pairing_id: string | null; agent_id: string | null; stable_id: string | null; android_id: string | null; agent_token_hash: string | null } | undefined;
  if (!device?.agent_token_hash) return null;
  const actualHash = crypto.createHash("sha256").update(token).digest("hex");
  const left = Buffer.from(actualHash);
  const right = Buffer.from(device.agent_token_hash);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  const knownIdentities = new Set([device.pairing_id, device.agent_id, device.stable_id, device.android_id].filter(Boolean).map(String));
  return candidates.every((candidate) => knownIdentities.has(String(candidate))) ? device : null;
}
