import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  createRoom,
  getRoom,
  joinRoom,
  issueInvite,
  generateRoomId,
  generateToken,
} from "../db/index.js";
import { rateLimiter } from "../middleware/rate-limit.js";

const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_COLLISION_RETRIES = 3;

export function roomRoutes(db: Database): Hono {
  const router = new Hono();
  const createRoomWithInvite = db.transaction(
    (
      roomId: string,
      hostToken: string,
      openingMessage: string,
      inviteToken: string,
      inviteExpiresAt?: string,
    ) => {
      const room = createRoom(db, roomId, hostToken, openingMessage);
      const invite = issueInvite(db, roomId, inviteToken, inviteExpiresAt);
      return { room, invite };
    },
  );

  router.post("/rooms", async (c) => {
    let body: { openingMessage?: unknown; inviteTtlSeconds?: unknown };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const openingMessage =
      typeof body.openingMessage === "string" ? body.openingMessage.trim() : "";
    if (openingMessage.length === 0) {
      return c.json({ error: "invalid_opening_message" }, 400);
    }

    if (
      body.inviteTtlSeconds !== undefined &&
      (typeof body.inviteTtlSeconds !== "number" ||
        !Number.isInteger(body.inviteTtlSeconds) ||
        body.inviteTtlSeconds <= 0)
    ) {
      return c.json({ error: "invalid_invite_ttl_seconds" }, 400);
    }

    const inviteExpiresAt =
      typeof body.inviteTtlSeconds === "number"
        ? new Date(Date.now() + body.inviteTtlSeconds * 1000).toISOString()
        : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
      const roomId = generateRoomId();
      const hostToken = generateToken();
      const inviteToken = generateToken();
      try {
        createRoomWithInvite(
          roomId,
          hostToken,
          openingMessage,
          inviteToken,
          inviteExpiresAt,
        );
        const inviteUrl = new URL(`/j/${inviteToken}`, c.req.url).toString();
        return c.json({ roomId, hostToken, inviteUrl }, 201);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE constraint failed") || msg.includes("PRIMARY KEY")) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  });

  const joinRateLimit = rateLimiter(10, 60_000);

  router.post("/rooms/:id/join", joinRateLimit, async (c) => {
    const id = c.req.param("id");

    if (!ROOM_ID_PATTERN.test(id)) {
      return c.json({ error: "invalid_room_id" }, 400);
    }

    const room = getRoom(db, id);
    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }
    if (room.status === "expired" || room.status === "closed") {
      return c.json({ error: "room_expired" }, 410);
    }
    if (room.guest_token !== null) {
      return c.json({ error: "room_full" }, 409);
    }

    const guestToken = generateToken();
    joinRoom(db, id, guestToken);
    return c.json({ guestToken }, 200);
  });

  return router;
}
