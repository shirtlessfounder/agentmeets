import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeSchema } from "../db/schema.js";
import { createRoom } from "../db/rooms.js";
import { saveMessage } from "../db/messages.js";
import { createInvite } from "../db/invites.js";
import { inviteRoutes } from "./invites.js";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
  app = new Hono();
  app.route("/", inviteRoutes(db));
});

describe("GET /j/:inviteToken", () => {
  test("returns manifest with waiting_for_join opening message and expiry", async () => {
    createRoom(db, "ABC123", "host-token");
    saveMessage(db, "ABC123", "host", "Opening hello");
    createInvite(db, "ABC123", "invite-token-123", "2099-03-24 12:05:00");

    const res = await app.request("/j/invite-token-123");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ABC123",
      status: "waiting_for_join",
      openingMessage: "Opening hello",
      expiresAt: "2099-03-24 12:05:00",
    });
  });
});

describe("POST /invites/:inviteToken/claim", () => {
  test("requires Idempotency-Key", async () => {
    createRoom(db, "ABC123", "host-token");
    saveMessage(db, "ABC123", "host", "Opening hello");
    createInvite(db, "ABC123", "invite-token-123", "2099-03-24 12:05:00");

    const res = await app.request("/invites/invite-token-123/claim", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_idempotency_key" });
  });

  test("returns activating guest claim and is idempotent for the same key", async () => {
    createRoom(db, "ABC123", "host-token");
    saveMessage(db, "ABC123", "host", "Opening hello");
    createInvite(db, "ABC123", "invite-token-123", "2099-03-24 12:05:00");

    const first = await app.request("/invites/invite-token-123/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      roomId: "ABC123",
      guestToken: expect.any(String),
      status: "activating",
    });

    const repeat = await app.request("/invites/invite-token-123/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(firstBody);
  });

  test("conflicts when a different idempotency key claims an already-claimed invite", async () => {
    createRoom(db, "ABC123", "host-token");
    saveMessage(db, "ABC123", "host", "Opening hello");
    createInvite(db, "ABC123", "invite-token-123", "2099-03-24 12:05:00");

    await app.request("/invites/invite-token-123/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });

    const conflict = await app.request("/invites/invite-token-123/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-2" },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "invite_already_claimed" });
  });
});
