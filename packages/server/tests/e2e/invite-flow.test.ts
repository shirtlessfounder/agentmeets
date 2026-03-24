import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ServerMessage } from "@agentmeets/shared";
import { initializeSchema } from "../../src/db/schema.js";
import { RoomManager } from "../../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../../src/ws/handler.js";
import { handleUpgrade } from "../../src/ws/upgrade.js";
import type { WsData } from "../../src/ws/room-manager.js";
import { roomRoutes } from "../../src/routes/rooms.js";
import { inviteRoutes } from "../../src/routes/invites.js";

let db: Database;
let app: Hono;
let server: ReturnType<typeof Bun.serve>;
let roomManager: RoomManager;
let port: number;

async function buildApp(): Promise<Hono> {
  const nextApp = new Hono();
  nextApp.route("/", roomRoutes(db));
  nextApp.route("/", inviteRoutes(db));
  return nextApp;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => reject(new Error("Timeout waiting for open")), 5000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (event) => {
        clearTimeout(timeout);
        reject(event);
      },
      { once: true },
    );
  });
}

function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data as string));
      },
      { once: true },
    );
  });
}

beforeEach(async () => {
  db = new Database(":memory:");
  initializeSchema(db);
  app = await buildApp();
  roomManager = new RoomManager(db);
  const wsHandlers = createWebSocketHandlers(roomManager);
  server = Bun.serve<WsData>({
    port: 0,
    fetch(req, srv) {
      const upgradeResponse = handleUpgrade(req, srv, db, roomManager);
      if (upgradeResponse) {
        return upgradeResponse;
      }

      const url = new URL(req.url);
      if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
        return undefined as unknown as Response;
      }

      return app.fetch(req);
    },
    websocket: wsHandlers,
  });
  port = server.port;
});

afterEach(() => {
  server.stop(true);
  db.close();
});

describe("invite flow", () => {
  test("create room -> inspect manifest -> claim invite -> activate over websockets", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Let's debug the release pipeline." }),
    });
    expect(createResponse.status).toBe(201);

    const created = await createResponse.json();
    expect(created).toEqual({
      roomId: expect.stringMatching(/^[A-Z0-9]{6}$/),
      hostToken: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      inviteUrl: expect.stringMatching(
        new RegExp(`^http://localhost:${port}/j/[A-Za-z0-9_-]+$`),
      ),
    });

    const inviteToken = new URL(created.inviteUrl).pathname.split("/").pop()!;

    const manifestBeforeClaim = await fetch(`${baseUrl}/j/${inviteToken}`);
    expect(manifestBeforeClaim.status).toBe(200);
    expect(await manifestBeforeClaim.json()).toEqual({
      roomId: created.roomId,
      status: "waiting_for_join",
      openingMessage: "Let's debug the release pipeline.",
      expiresAt: expect.any(String),
    });

    const claimResponse = await fetch(`${baseUrl}/invites/${inviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "invite-flow-claim" },
    });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json();
    expect(claim).toEqual({
      roomId: created.roomId,
      guestToken: expect.any(String),
      status: "activating",
    });

    const manifestAfterClaim = await fetch(`${baseUrl}/j/${inviteToken}`);
    expect(manifestAfterClaim.status).toBe(200);
    expect(await manifestAfterClaim.json()).toEqual({
      roomId: created.roomId,
      status: "activating",
      openingMessage: "Let's debug the release pipeline.",
      expiresAt: expect.any(String),
    });

    const roomRow = db
      .prepare("SELECT guest_token, joined_at, status FROM rooms WHERE id = ?")
      .get(created.roomId) as {
      guest_token: string | null;
      joined_at: string | null;
      status: string;
    };
    expect(roomRow.guest_token).toBe(claim.guestToken);
    expect(roomRow.joined_at).toBeNull();
    expect(roomRow.status).toBe("waiting");

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${created.hostToken}`,
    );
    await waitForOpen(hostWs);

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${claim.guestToken}`,
    );
    await waitForOpen(guestWs);

    expect(await hostActivationPromise).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });

    const manifestAfterActivation = await fetch(`${baseUrl}/j/${inviteToken}`);
    expect(manifestAfterActivation.status).toBe(200);
    expect(await manifestAfterActivation.json()).toEqual({
      roomId: created.roomId,
      status: "active",
      openingMessage: "Let's debug the release pipeline.",
      expiresAt: expect.any(String),
    });

    const activatedRoomRow = db
      .prepare("SELECT guest_token, joined_at, status FROM rooms WHERE id = ?")
      .get(created.roomId) as {
      guest_token: string | null;
      joined_at: string | null;
      status: string;
    };
    expect(activatedRoomRow.guest_token).toBe(claim.guestToken);
    expect(activatedRoomRow.joined_at).toEqual(expect.any(String));
    expect(activatedRoomRow.status).toBe("active");

    hostWs.close();
    guestWs.close();
  });
});
