import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

class FakeRuntimeAdapter {
  readonly surfaces: string[] = [];
  readonly remoteMessages: Array<{ remoteRole: "host" | "guest"; content: string }> =
    [];
  readonly draftModes: Array<{
    originalDraft: string;
    workingDraft: string;
    controls: string[];
  }> = [];
  readonly revisionRequests: Array<{
    originalDraft: string;
    workingDraft: string;
    feedback: string | null;
  }> = [];

  #draftModeActive = false;

  async renderLocalSurface(content: string): Promise<void> {
    this.surfaces.push(content);
  }

  async injectRemoteMessage(input: {
    remoteRole: "host" | "guest";
    content: string;
  }): Promise<void> {
    this.remoteMessages.push(input);
  }

  async renderDraftMode(input: {
    originalDraft: string;
    workingDraft: string;
    controls: string[];
  }): Promise<void> {
    this.#draftModeActive = true;
    this.draftModes.push(input);
  }

  async requestDraftRevision(input: {
    originalDraft: string;
    workingDraft: string;
    feedback: string | null;
  }): Promise<void> {
    this.revisionRequests.push(input);
  }

  routeDraftCommand(input: string):
    | { kind: "submit_draft"; content: string }
    | { kind: "send_draft" }
    | { kind: "regenerate_draft" }
    | { kind: "revert_draft" }
    | { kind: "end_session" }
    | { kind: "draft_feedback"; feedback: string }
    | null {
    const trimmed = input.trim();

    if (trimmed.startsWith("/draft ")) {
      return {
        kind: "submit_draft",
        content: trimmed.slice("/draft ".length),
      };
    }

    if (trimmed === "/send") {
      return { kind: "send_draft" };
    }

    if (trimmed === "/regenerate") {
      return { kind: "regenerate_draft" };
    }

    if (trimmed === "/revert") {
      return { kind: "revert_draft" };
    }

    if (trimmed === "/end") {
      return { kind: "end_session" };
    }

    if (trimmed.length > 0 && this.#draftModeActive) {
      return {
        kind: "draft_feedback",
        feedback: trimmed,
      };
    }

    return null;
  }
}

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;

  #listeners = new Map<
    string,
    Array<{ listener: (event: any) => void; once: boolean }>
  >();
  #autoOpen: boolean;
  #openError: Error | null;

  constructor(
    url: string,
    options: { autoOpen?: boolean; openError?: Error | null } = {},
  ) {
    this.url = url;
    this.#autoOpen = options.autoOpen ?? false;
    this.#openError = options.openError ?? null;

    if (this.#autoOpen) {
      queueMicrotask(() => {
        if (this.#openError) {
          this.emit("error", this.#openError);
          return;
        }

        this.readyState = 1;
        this.emit("open", { type: "open" });
      });
    }
  }

  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const list = this.#listeners.get(type) ?? [];
    list.push({ listener, once: options?.once === true });
    this.#listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", { type: "close" });
  }

  emitMessage(data: object): void {
    this.emit("message", {
      data: JSON.stringify(data),
    });
  }

  private emit(type: string, event: any): void {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    if (listeners.length === 0) {
      return;
    }

    this.#listeners.set(
      type,
      listeners.filter((entry) => !entry.once),
    );

    for (const { listener } of listeners) {
      listener(event);
    }
  }
}

describe("runSessionRuntime", () => {
  test("renders connected and waiting helper surfaces after bootstrap", async () => {
    const module = await import("./runtime.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-runtime-"));
    tempDirs.push(rootDir);

    const adapter = new FakeRuntimeAdapter();
    const ws = new FakeWebSocket(
      "ws://agentmeets.test/rooms/ROOM-123/ws?token=guest-session-token",
      { autoOpen: true },
    );

    const runtime = await module.runSessionRuntime({
      rootDir,
      roomId: "ROOM-123",
      wsUrl: ws.url,
      role: "guest",
      roomLabel: "Room r_9wK3mQvH8",
      initialStatus: "waiting_for_host",
      adapter,
      webSocketFactory: () => ws,
    });

    expect(adapter.surfaces[0]).toContain("connected");
    expect(adapter.surfaces[1]).toContain("waiting for host");

    runtime.close();
  });

  test("stages pre-activation sends after the 5 second hold and releases queued inbound only after ack", async () => {
    const module = await import("./runtime.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-runtime-"));
    tempDirs.push(rootDir);

    const adapter = new FakeRuntimeAdapter();
    const ws = new FakeWebSocket(
      "ws://agentmeets.test/rooms/ROOM-234/ws?token=guest-session-token",
      { autoOpen: true },
    );
    let scheduledCallback: (() => void) | null = null;

    const runtime = await module.runSessionRuntime({
      rootDir,
      roomId: "ROOM-234",
      wsUrl: ws.url,
      role: "guest",
      roomLabel: "Room r_9wK3mQvH8",
      initialStatus: "waiting_for_host",
      adapter,
      webSocketFactory: () => ws,
      countdownOptions: {
        setTimeoutFn(callback: () => void) {
          scheduledCallback = callback;
          return { id: "timer-1" } as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeoutFn() {},
      },
    });

    ws.emitMessage({
      type: "message",
      messageId: 7,
      sender: "host",
      clientMessageId: "persisted:7",
      replyToMessageId: null,
      content: "Opening message from the room creator.",
      createdAt: "2026-03-27 12:00:07",
    });
    await runtime.waitForIdle();

    expect(adapter.remoteMessages).toEqual([
      {
        remoteRole: "host",
        content: "Opening message from the room creator.",
      },
    ]);

    await runtime.handleSessionInput("/draft First draft");
    await runtime.waitForIdle();

    expect(runtime.getState()).toMatchObject({
      status: "hold_countdown",
      activeMessageId: 7,
      originalDraft: "First draft",
      workingDraft: "First draft",
    });
    expect(adapter.surfaces.at(-1)).toContain("Sending in 5s. Press e to edit.");

    scheduledCallback?.();
    await runtime.waitForIdle();

    expect(runtime.getState()).toMatchObject({
      status: "draft_mode",
      stagedBeforeActivation: true,
      pendingClientMessageId: null,
    });
    expect(adapter.surfaces.at(-1)).toContain("staged");

    ws.emitMessage({
      type: "room_active",
      roomId: "ROOM-234",
    });
    await runtime.waitForIdle();

    const outbound = JSON.parse(ws.sent[0] ?? "{}") as Record<string, unknown>;
    expect(outbound).toMatchObject({
      type: "message",
      content: "First draft",
      replyToMessageId: 7,
    });

    ws.emitMessage({
      type: "message",
      messageId: 8,
      sender: "host",
      clientMessageId: "host-8",
      replyToMessageId: 7,
      content: "Queued while ack is pending.",
      createdAt: "2026-03-27 12:00:08",
    });
    await runtime.waitForIdle();

    expect(adapter.remoteMessages).toHaveLength(1);

    ws.emitMessage({
      type: "ack",
      messageId: 9,
      clientMessageId: String(outbound.clientMessageId),
      replyToMessageId: 7,
      createdAt: "2026-03-27 12:00:09",
    });
    await runtime.waitForIdle();

    expect(adapter.remoteMessages).toEqual([
      {
        remoteRole: "host",
        content: "Opening message from the room creator.",
      },
      {
        remoteRole: "host",
        content: "Queued while ack is pending.",
      },
    ]);
    expect(runtime.getState()).toMatchObject({
      status: "drafting_reply",
      activeMessageId: 8,
      queuedInbound: [],
      pendingClientMessageId: null,
      lastAckedMessageId: 9,
    });

    runtime.close();
  });

  test("supports manual draft controls and preserves originalDraft across regenerations", async () => {
    const module = await import("./runtime.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-runtime-"));
    tempDirs.push(rootDir);

    const adapter = new FakeRuntimeAdapter();
    const ws = new FakeWebSocket(
      "ws://agentmeets.test/rooms/ROOM-345/ws?token=guest-session-token",
      { autoOpen: true },
    );

    const runtime = await module.runSessionRuntime({
      rootDir,
      roomId: "ROOM-345",
      wsUrl: ws.url,
      role: "guest",
      roomLabel: "Room r_9wK3mQvH8",
      initialStatus: "active",
      adapter,
      webSocketFactory: () => ws,
      countdownOptions: {
        setTimeoutFn() {
          return { id: "timer-2" } as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeoutFn() {},
      },
    });

    ws.emitMessage({
      type: "room_active",
      roomId: "ROOM-345",
    });
    ws.emitMessage({
      type: "message",
      messageId: 12,
      sender: "host",
      clientMessageId: "host-12",
      replyToMessageId: null,
      content: "Please tighten this summary.",
      createdAt: "2026-03-27 12:00:12",
    });
    await runtime.waitForIdle();

    await runtime.handleSessionInput("/draft Initial summary.");
    await runtime.waitForIdle();
    await runtime.handleKeypress("e");
    await runtime.waitForIdle();

    expect(runtime.getState()).toMatchObject({
      status: "draft_mode",
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
    });
    expect(adapter.draftModes.at(-1)).toMatchObject({
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
      controls: ["/send", "/regenerate", "/revert", "/end"],
    });

    await runtime.handleSessionInput("make it shorter");
    await runtime.waitForIdle();
    expect(adapter.revisionRequests.at(-1)).toMatchObject({
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
      feedback: "make it shorter",
    });

    await runtime.handleSessionInput("/draft Shorter summary.");
    await runtime.waitForIdle();
    expect(runtime.getState()).toMatchObject({
      status: "draft_mode",
      originalDraft: "Initial summary.",
      workingDraft: "Shorter summary.",
    });

    await runtime.handleSessionInput("/revert");
    await runtime.waitForIdle();
    expect(runtime.getState()).toMatchObject({
      status: "draft_mode",
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
    });

    await runtime.handleSessionInput("/send");
    await runtime.waitForIdle();

    const outbound = JSON.parse(ws.sent[0] ?? "{}") as Record<string, unknown>;
    expect(outbound).toMatchObject({
      type: "message",
      content: "Initial summary.",
      replyToMessageId: 12,
    });

    runtime.close();
  });

  test("renders the deterministic runtime failure surface when the websocket cannot open", async () => {
    const module = await import("./runtime.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-runtime-"));
    tempDirs.push(rootDir);

    const adapter = new FakeRuntimeAdapter();

    await expect(
      module.runSessionRuntime({
        rootDir,
        roomId: "ROOM-456",
        wsUrl: "ws://agentmeets.test/rooms/ROOM-456/ws?token=guest-session-token",
        role: "guest",
        roomLabel: "Room r_9wK3mQvH8",
        initialStatus: "waiting_for_host",
        adapter,
        webSocketFactory: (url: string) =>
          new FakeWebSocket(url, {
            autoOpen: true,
            openError: new Error("WebSocket connection failed"),
          }),
      }),
    ).rejects.toMatchObject({
      message: "runtime_failure",
    });

    expect(adapter.surfaces.at(-1)).toContain("runtime_failure");
  });
});
