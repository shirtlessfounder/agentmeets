import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { derivePublicRoomStatus } from "@agentmeets/shared";
import { expireRoom } from "../db/rooms.js";

interface PublicRoomRow {
  room_id: string;
  room_stem: string;
  room_status: "waiting" | "active" | "closed" | "expired";
  host_connected_at: string | null;
  guest_connected_at: string | null;
  invite_expires_at: string | null;
}

export function publicRoomRoutes(db: Database): Hono {
  const router = new Hono();

  router.get("/public/rooms/:roomStem", (c) => {
    const roomStem = c.req.param("roomStem");
    const room = getPublicRoomRow(db, roomStem);

    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }

    if (isPublicRoomExpired(db, room)) {
      return c.json({ error: "room_expired" }, 410);
    }

    return c.json(
      {
        roomId: room.room_id,
        roomStem: room.room_stem,
        status: deriveRouteStatus(room),
        hostAgentLink: new URL(`/j/${room.room_stem}.1`, c.req.url).toString(),
        guestAgentLink: new URL(`/j/${room.room_stem}.2`, c.req.url).toString(),
        inviteExpiresAt: room.invite_expires_at,
      },
      200,
    );
  });

  return router;
}

function getPublicRoomRow(
  db: Database,
  roomStem: string,
): PublicRoomRow | null {
  const row = db
    .prepare(
      `SELECT
         r.id AS room_id,
         r.room_stem,
         r.status AS room_status,
         r.host_connected_at,
         r.guest_connected_at,
         MIN(i.expires_at) AS invite_expires_at
       FROM rooms r
       LEFT JOIN invites i ON i.room_id = r.id
       WHERE r.room_stem = ?
       GROUP BY r.id, r.room_stem, r.status, r.host_connected_at, r.guest_connected_at`,
    )
    .get(roomStem) as PublicRoomRow | null;

  return row ?? null;
}

function isPublicRoomExpired(db: Database, room: PublicRoomRow): boolean {
  if (room.room_status === "active") {
    return false;
  }

  if (room.room_status === "closed") {
    return false;
  }

  if (room.room_status === "expired") {
    return true;
  }

  if (!room.invite_expires_at) {
    return false;
  }

  if (new Date(room.invite_expires_at).getTime() > Date.now()) {
    return false;
  }

  if (room.room_status === "waiting") {
    expireRoom(db, room.room_id);
  }

  return true;
}

function deriveRouteStatus(room: PublicRoomRow) {
  return derivePublicRoomStatus({
    roomStatus: room.room_status,
    hostConnectedAt: room.host_connected_at,
    guestConnectedAt: room.guest_connected_at,
  });
}
