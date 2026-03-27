import { describe, expect, test } from "bun:test";

describe("bootstrapInviteRuntime", () => {
  test("accepts canonical pasted invite instructions and returns runtime bootstrap metadata", async () => {
    const module = await import("./bootstrap.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const hostLink = "https://agentmeets.test/j/r_9wK3mQvH8.1";
    const fetchCalls: Array<{ url: string; method: string; headers: Headers }> = [];

    const result = await module.bootstrapInviteRuntime({
      pastedText: `Tell your agent to join this chat: ${hostLink}`,
      adapterName: "codex",
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
        });

        if (url === hostLink) {
          return new Response(
            JSON.stringify({
              roomId: "ROOM-123",
              roomStem: "r_9wK3mQvH8",
              role: "host",
              status: "waiting_for_guest",
              openingMessage: "Opening message from the room creator.",
              expiresAt: "2026-03-27T12:05:00.000Z",
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            roomId: "ROOM-123",
            role: "host",
            sessionToken: "host-session-token",
            status: "waiting_for_guest",
          }),
          { status: 200 },
        );
      },
    });

    expect(result).toMatchObject({
      adapterName: "codex",
      role: "host",
      roomId: "ROOM-123",
      roomLabel: "Room r_9wK3mQvH8",
      status: "waiting_for_guest",
      openingMessage: "Opening message from the room creator.",
      sessionToken: "host-session-token",
      wsUrl: "wss://agentmeets.test/rooms/ROOM-123/ws?token=host-session-token",
    });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toMatchObject({
      url: hostLink,
      method: "GET",
    });
    expect(fetchCalls[1]).toMatchObject({
      url: "https://agentmeets.test/invites/r_9wK3mQvH8.1/claim",
      method: "POST",
    });
    expect(fetchCalls[1]?.headers.get("Idempotency-Key")).toBe(
      "agentmeets-session-host-r_9wK3mQvH8.1",
    );
  });

  test("accepts raw invite links with no surrounding text", async () => {
    const module = await import("./bootstrap.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const guestLink = "https://agentmeets.test/j/r_9wK3mQvH8.2";

    const result = await module.bootstrapInviteRuntime({
      pastedText: guestLink,
      adapterName: "claude-code",
      fetchFn: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === guestLink) {
          return new Response(
            JSON.stringify({
              roomId: "ROOM-456",
              roomStem: "r_9wK3mQvH8",
              role: "guest",
              status: "waiting_for_host",
              openingMessage: "Opening message from the room creator.",
              expiresAt: "2026-03-27T12:05:00.000Z",
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            roomId: "ROOM-456",
            role: "guest",
            sessionToken: "guest-session-token",
            status: "waiting_for_host",
          }),
          { status: 200 },
        );
      },
    });

    expect(result).toMatchObject({
      adapterName: "claude-code",
      role: "guest",
      roomId: "ROOM-456",
      roomLabel: "Room r_9wK3mQvH8",
      status: "waiting_for_host",
      wsUrl: "wss://agentmeets.test/rooms/ROOM-456/ws?token=guest-session-token",
    });
  });

  test("fails deterministically for invalid invite text", async () => {
    const module = await import("./bootstrap.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    await expect(
      module.bootstrapInviteRuntime({
        pastedText: "This is not an AgentMeets invite.",
        adapterName: "claude-code",
      }),
    ).rejects.toMatchObject({
      code: "invalid_invite",
    });
  });

  test("maps expired invites to the deterministic invite_expired failure class", async () => {
    const module = await import("./bootstrap.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    await expect(
      module.bootstrapInviteRuntime({
        pastedText: "https://agentmeets.test/j/r_9wK3mQvH8.2",
        adapterName: "codex",
        fetchFn: async () =>
          new Response(JSON.stringify({ error: "invite_expired" }), {
            status: 410,
          }),
      }),
    ).rejects.toMatchObject({
      code: "invite_expired",
    });
  });
});
