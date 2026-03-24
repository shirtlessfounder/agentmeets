import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RoomStatus } from "@agentmeets/shared";
import { expireRoom } from "./rooms.js";

const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;

interface InviteLookupRow {
  room_id: string;
  room_status: string;
  guest_token: string | null;
  joined_at: string | null;
  opening_message: string | null;
  expires_at: string;
  claimed_at: string | null;
  claim_idempotency_key: string | null;
  claim_guest_token: string | null;
}

export interface InviteManifest {
  roomId: string;
  status: RoomStatus;
  openingMessage: string;
  expiresAt: string;
}

export interface InviteClaimResult {
  roomId: string;
  guestToken: string;
  status: "activating";
}

export class InviteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export function createInvite(
  db: Database,
  roomId: string,
  inviteToken: string,
  expiresAt: string = new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString(),
): { expiresAt: string } {
  db.prepare(
    `INSERT INTO invites (room_id, token_hash, expires_at) VALUES (?, ?, ?)`,
  ).run(roomId, hashInviteToken(inviteToken), expiresAt);

  return { expiresAt };
}

export const issueInvite = createInvite;

export function getInviteManifest(
  db: Database,
  inviteToken: string,
): InviteManifest {
  const record = getInviteLookup(db, inviteToken);
  if (!record) {
    throw new InviteError("Invite not found", 404, "invite_not_found");
  }

  ensureInviteUsable(db, record);

  return {
    roomId: record.room_id,
    status: deriveInviteStatus(record),
    openingMessage: record.opening_message ?? "",
    expiresAt: record.expires_at,
  };
}

export function claimInvite(
  db: Database,
  inviteToken: string,
  idempotencyKey: string,
): InviteClaimResult {
  return db.transaction(() => {
    const record = getInviteLookup(db, inviteToken);
    if (!record) {
      throw new InviteError("Invite not found", 404, "invite_not_found");
    }

    if (record.claimed_at !== null) {
      if (record.claim_idempotency_key === idempotencyKey) {
        const guestToken = record.claim_guest_token ?? record.guest_token;
        if (!guestToken) {
          throw new InviteError(
            "Invite claim state is invalid",
            500,
            "invite_claim_invalid",
          );
        }

        return {
          roomId: record.room_id,
          guestToken,
          status: "activating" as const,
        };
      }

      throw new InviteError(
        "Invite has already been claimed",
        409,
        "invite_already_claimed",
      );
    }

    ensureInviteUsable(db, record);

    if (record.guest_token !== null) {
      throw new InviteError(
        "Invite has already been claimed",
        409,
        "invite_already_claimed",
      );
    }

    const guestToken = crypto.randomUUID();
    const claimedAt = new Date().toISOString();

    db.prepare(
      `UPDATE rooms
       SET guest_token = ?
       WHERE id = ?`,
    ).run(guestToken, record.room_id);

    db.prepare(
      `UPDATE invites
       SET claimed_at = ?,
           claim_idempotency_key = ?,
           claim_guest_token = ?
       WHERE token_hash = ?`,
    ).run(
      claimedAt,
      idempotencyKey,
      guestToken,
      hashInviteToken(inviteToken),
    );

    return {
      roomId: record.room_id,
      guestToken,
      status: "activating" as const,
    };
  })();
}

function getInviteLookup(
  db: Database,
  inviteToken: string,
): InviteLookupRow | null {
  const record = db
    .prepare(
      `SELECT
         i.room_id,
         r.status AS room_status,
         r.guest_token,
         r.joined_at,
         COALESCE(
           opening_message.content,
           (
             SELECT fallback.content
             FROM messages fallback
             WHERE fallback.room_id = r.id
               AND fallback.sender = 'host'
             ORDER BY fallback.id ASC
             LIMIT 1
           )
         ) AS opening_message,
         i.expires_at,
         i.claimed_at,
         i.claim_idempotency_key,
         i.claim_guest_token
       FROM invites i
       JOIN rooms r ON r.id = i.room_id
       LEFT JOIN messages opening_message ON opening_message.id = r.opening_message_id
       WHERE i.token_hash = ?`,
    )
    .get(hashInviteToken(inviteToken)) as InviteLookupRow | null;

  return record ?? null;
}

function ensureInviteUsable(db: Database, record: InviteLookupRow): void {
  if (record.room_status === "closed") {
    throw new InviteError("Room has ended", 410, "invite_expired");
  }
  if (record.room_status === "expired") {
    throw new InviteError("Invite has expired", 410, "invite_expired");
  }
  if (new Date(record.expires_at).getTime() <= Date.now()) {
    if (record.room_status === "waiting" && record.guest_token === null) {
      expireRoom(db, record.room_id);
    }
    throw new InviteError("Invite has expired", 410, "invite_expired");
  }
}

function deriveInviteStatus(record: InviteLookupRow): RoomStatus {
  if (record.room_status === "active") {
    return "active";
  }
  if (record.room_status === "closed") {
    return "ended";
  }
  if (record.room_status === "expired") {
    return "expired";
  }
  if (record.guest_token !== null || record.claimed_at !== null) {
    return "activating";
  }
  return "waiting_for_join";
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
