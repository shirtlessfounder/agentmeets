import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { claimInvite, getInviteManifest, InviteError } from "../db/index.js";

export function inviteRoutes(db: Database): Hono {
  const router = new Hono();

  router.get("/j/:inviteToken", (c) => {
    try {
      return c.json(getInviteManifest(db, c.req.param("inviteToken")), 200);
    } catch (error) {
      if (error instanceof InviteError) {
        return c.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  router.post("/invites/:inviteToken/claim", (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      return c.json({ error: "missing_idempotency_key" }, 400);
    }

    try {
      return c.json(
        claimInvite(db, c.req.param("inviteToken"), idempotencyKey),
        200,
      );
    } catch (error) {
      if (error instanceof InviteError) {
        return c.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  return router;
}
