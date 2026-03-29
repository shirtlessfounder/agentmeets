import { describe, expect, test } from "bun:test";

function parseToolResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  #listeners = new Map<
    string,
    Array<{ listener: (event: any) => void; once: boolean }>
  >();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.#dispatch("open", { type: "open" });
    });
  }

  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const entries = this.#listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once ?? false });
    this.#listeners.set(type, entries);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#dispatch("close", { type: "close", code, reason });
  }

  emitMessage(data: object): void {
    this.#dispatch("message", { type: "message", data: JSON.stringify(data) });
  }

  #dispatch(type: string, event: any): void {
    const listeners = this.#listeners.get(type) ?? [];
    const retained: Array<{ listener: (event: any) => void; once: boolean }> =
      [];

    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        retained.push(entry);
      }
    }

    this.#listeners.set(type, retained);
  }
}

async function createConnectedController() {
  const module = await import("./controller.js");
  const sockets: FakeWebSocket[] = [];

  const controller = module.createMeetController({
    serverUrl: "https://agentmeets.test",
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://agentmeets.test/rooms") {
        return new Response(
          JSON.stringify({
            roomId: "ROOM01",
            roomStem: "r_staged",
            hostAgentLink: "https://agentmeets.test/j/r_staged.1",
            guestAgentLink: "https://agentmeets.test/j/r_staged.2",
            inviteExpiresAt: "2026-03-25T18:12:00.000Z",
            status: "waiting_for_both",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "https://agentmeets.test/invites/r_staged.1/claim") {
        return new Response(
          JSON.stringify({
            roomId: "ROOM01",
            role: "host",
            sessionToken: "host-token",
            status: "activating",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    webSocketFactory(url: string) {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    settleDelayMs: 0,
  });

  await controller.createMeet({ openingMessage: "Staged test" });
  await controller.hostMeet({
    participantLink: "https://agentmeets.test/j/r_staged.1",
  });

  return { controller, sockets };
}

describe("mandatory staging flow", () => {
  test("send_and_wait stages draft and returns draftId with holdSeconds", async () => {
    const { controller } = await createConnectedController();

    const result = await controller.sendAndWait({ message: "Draft message" });
    const data = parseToolResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.status).toBe("staged");
    expect(data.message).toBe("Draft message");
    expect(data.originalDraft).toBe("Draft message");
    expect(data.holdSeconds).toBe(5);
    expect(typeof data.draftId).toBe("string");
    expect((data.draftId as string).length).toBeGreaterThan(0);
    expect(data.instruction).toContain("auto-send");

    await controller.endMeet();
  });

  test("send_and_wait errors when no active meet", async () => {
    const module = await import("./controller.js");

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async () => new Response("", { status: 500 }),
      webSocketFactory: (url: string) =>
        new FakeWebSocket(url) as unknown as WebSocket,
      settleDelayMs: 0,
    });

    const result = await controller.sendAndWait({ message: "Draft" });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/no active meet/i);
  });

  test("confirm_send sends the staged draft and returns reply", async () => {
    const { controller, sockets } = await createConnectedController();

    const staged = parseToolResult(
      await controller.sendAndWait({ message: "Approved draft" }),
    );
    const draftId = staged.draftId as string;

    const replyPromise = controller.confirmSend({ draftId, timeout: 5 });

    await new Promise((r) => setTimeout(r, 10));

    const ws = sockets[0]!;
    const sent = JSON.parse(ws.sent[0]!) as {
      type: string;
      clientMessageId: string;
      content: string;
    };
    expect(sent.type).toBe("message");
    expect(sent.content).toBe("Approved draft");

    ws.emitMessage({
      type: "ack",
      messageId: 1,
      clientMessageId: sent.clientMessageId,
      replyToMessageId: null,
      createdAt: "2026-03-25T18:12:01.000Z",
    });
    ws.emitMessage({
      type: "message",
      messageId: 2,
      sender: "guest",
      clientMessageId: "guest-reply",
      replyToMessageId: 1,
      content: "Got your approved draft.",
      createdAt: "2026-03-25T18:12:02.000Z",
    });

    const result = parseToolResult(await replyPromise);
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("Got your approved draft.");

    await controller.endMeet();
  });

  test("confirm_send errors on wrong draftId", async () => {
    const { controller } = await createConnectedController();

    await controller.sendAndWait({ message: "Some draft" });

    const result = await controller.confirmSend({
      draftId: "wrong-id",
      timeout: 5,
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/draft id mismatch/i);

    await controller.endMeet();
  });

  test("confirm_send errors when no staged draft", async () => {
    const { controller } = await createConnectedController();

    const result = await controller.confirmSend({
      draftId: "any-id",
      timeout: 5,
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/no staged draft/i);

    await controller.endMeet();
  });

  test("revise_draft updates draft content and preserves originalDraft", async () => {
    const { controller } = await createConnectedController();

    const staged = parseToolResult(
      await controller.sendAndWait({ message: "Original" }),
    );
    const draftId = staged.draftId as string;

    const revised = parseToolResult(
      await controller.reviseDraft({
        draftId,
        revisedMessage: "Revised content",
      }),
    );

    expect(revised.status).toBe("staged");
    expect(revised.draftId).toBe(draftId);
    expect(revised.message).toBe("Revised content");
    expect(revised.originalDraft).toBe("Original");

    await controller.endMeet();
  });

  test("revise_draft errors on wrong draftId", async () => {
    const { controller } = await createConnectedController();

    await controller.sendAndWait({ message: "Some draft" });

    const result = await controller.reviseDraft({
      draftId: "wrong-id",
      revisedMessage: "Nope",
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/draft id mismatch/i);

    await controller.endMeet();
  });

  test("revise_draft errors when no staged draft", async () => {
    const { controller } = await createConnectedController();

    const result = await controller.reviseDraft({
      draftId: "any-id",
      revisedMessage: "Nope",
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/no staged draft/i);

    await controller.endMeet();
  });

  test("send_and_wait replaces an existing staged draft", async () => {
    const { controller } = await createConnectedController();

    const first = parseToolResult(
      await controller.sendAndWait({ message: "First draft" }),
    );
    const second = parseToolResult(
      await controller.sendAndWait({ message: "Second draft" }),
    );

    expect(second.draftId).not.toBe(first.draftId);
    expect(second.message).toBe("Second draft");

    // Old draftId should now be invalid
    const sendOld = await controller.confirmSend({
      draftId: first.draftId as string,
      timeout: 5,
    });
    expect(sendOld.isError).toBe(true);
    expect(parseToolResult(sendOld).error).toMatch(/draft id mismatch/i);

    await controller.endMeet();
  });

  test("confirm_send clears draft so second confirm fails", async () => {
    const { controller, sockets } = await createConnectedController();

    const staged = parseToolResult(
      await controller.sendAndWait({ message: "One-time draft" }),
    );
    const draftId = staged.draftId as string;

    const replyPromise = controller.confirmSend({ draftId, timeout: 5 });

    await new Promise((r) => setTimeout(r, 10));

    const ws = sockets[0]!;
    const sent = JSON.parse(ws.sent[0]!) as {
      clientMessageId: string;
    };

    ws.emitMessage({
      type: "ack",
      messageId: 1,
      clientMessageId: sent.clientMessageId,
      replyToMessageId: null,
      createdAt: "2026-03-25T18:12:01.000Z",
    });
    ws.emitMessage({
      type: "message",
      messageId: 2,
      sender: "guest",
      clientMessageId: "g1",
      replyToMessageId: 1,
      content: "OK",
      createdAt: "2026-03-25T18:12:02.000Z",
    });

    await replyPromise;

    // Second confirm with same draftId should fail
    const result = await controller.confirmSend({ draftId, timeout: 5 });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/no staged draft/i);

    await controller.endMeet();
  });

  test("full round-trip: stage → revise → confirm → reply", async () => {
    const { controller, sockets } = await createConnectedController();

    // Stage
    const staged = parseToolResult(
      await controller.sendAndWait({ message: "First attempt" }),
    );
    expect(staged.status).toBe("staged");
    const draftId = staged.draftId as string;

    // Revise
    const revised = parseToolResult(
      await controller.reviseDraft({ draftId, revisedMessage: "Better version" }),
    );
    expect(revised.message).toBe("Better version");
    expect(revised.originalDraft).toBe("First attempt");

    // Confirm
    const replyPromise = controller.confirmSend({ draftId, timeout: 5 });

    await new Promise((r) => setTimeout(r, 10));

    const ws = sockets[0]!;
    const sent = JSON.parse(ws.sent[0]!) as {
      type: string;
      clientMessageId: string;
      content: string;
    };
    expect(sent.content).toBe("Better version");

    ws.emitMessage({
      type: "ack",
      messageId: 1,
      clientMessageId: sent.clientMessageId,
      replyToMessageId: null,
      createdAt: "2026-03-25T18:12:01.000Z",
    });
    ws.emitMessage({
      type: "message",
      messageId: 2,
      sender: "guest",
      clientMessageId: "g1",
      replyToMessageId: 1,
      content: "Got the better version.",
      createdAt: "2026-03-25T18:12:02.000Z",
    });

    const result = parseToolResult(await replyPromise);
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("Got the better version.");

    await controller.endMeet();
  });
});
