# AgentMeets Mandatory Staging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get AgentMeets from 36/75 to 75/75 requirements by implementing mandatory staging, server hardening, and deployment.

**Architecture:** Replace fire-and-forget `send_and_wait` with two-step staging (`send_and_wait` stages, `confirm_send` sends). Add CORS, graceful shutdown, logging, DB cleanup to server. Deploy server and UI. Update tests.

**Tech Stack:** TypeScript, Bun, Hono, MCP SDK, Next.js, SQLite

---

## Workstream Overview

| Workstream | Tasks | Dependencies |
|-----------|-------|-------------|
| **A: MCP Server Tools** | Tasks 1-5 | None |
| **B: Server Hardening** | Tasks 6-10 | None |
| **C: UI + Deployment** | Tasks 11-14 | None |
| **D: Testing + Scope** | Tasks 15-17 | After A and B |

Workstreams A, B, and C are fully independent and can run in parallel. Workstream D depends on A and B completing first.

---

## Workstream A: MCP Server Tools

These tasks transform the MCP tool interface to implement mandatory staging per the design spec.

### Task 1: Update StagedDraft interface and MeetController type

**Files:**
- Modify: `packages/mcp-server/src/client.ts`
- Modify: `packages/mcp-server/src/controller.ts` (type only)

- [ ] **Step 1: Update StagedDraft to include originalDraft**

In `packages/mcp-server/src/client.ts`, change the `StagedDraft` interface:

```typescript
export interface StagedDraft {
  id: string;
  message: string;
  originalDraft: string;
}
```

- [ ] **Step 2: Update MeetController interface**

In `packages/mcp-server/src/controller.ts`, replace the interface (lines 42-53) with:

```typescript
export interface MeetController {
  createMeet: ReturnType<typeof createCreateMeetHandler>;
  hostMeet(input: { participantLink: string }): Promise<ToolResult>;
  guestMeet(input: { participantLink: string }): Promise<ToolResult>;
  sendAndWait(input: { message: string; timeout?: number }): Promise<ToolResult>;
  confirmSend(input: { draftId: string; timeout?: number }): Promise<ToolResult>;
  reviseDraft(input: { draftId: string; revisedMessage: string }): Promise<ToolResult>;
  endMeet(): Promise<ToolResult>;
  getMeetState(): MeetState | null;
}
```

Removed: `joinMeet`, `stageReply`, `sendStaged`, `reviseStaged`.
Added: `confirmSend`, `reviseDraft`.

- [ ] **Step 3: Run tests to confirm they fail (expected)**

Run: `cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state && bun test packages/mcp-server`
Expected: Failures because old method names are gone.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/client.ts packages/mcp-server/src/controller.ts
git commit -m "refactor: update StagedDraft and MeetController types for mandatory staging"
```

---

### Task 2: Rewrite send_and_wait to stage-only, implement confirm_send and revise_draft

**Files:**
- Modify: `packages/mcp-server/src/controller.ts`

- [ ] **Step 1: Rewrite sendAndWait to stage-only**

Replace the existing `sendAndWait` method (currently at lines 197-254) with a staging-only version. The old send logic moves to `confirmSend`.

```typescript
async sendAndWait(input: { message: string; timeout?: number }): Promise<ToolResult> {
  const activeMeet = meetState;
  if (!activeMeet) {
    return errorResult("No active meet session");
  }

  const draftId = crypto.randomUUID();
  activeMeet.stagedDraft = {
    id: draftId,
    message: input.message,
    originalDraft: input.message,
  };

  return textResult({
    status: "staged",
    draftId,
    message: input.message,
    originalDraft: input.message,
    holdSeconds: 5,
    instruction:
      "Reply will auto-send in 5s. Tell your agent to edit it, or say 'send it' to send now.",
  });
},
```

- [ ] **Step 2: Implement confirmSend**

Add a new `confirmSend` method. This takes the old `sendAndWait` internals (the actual WebSocket send + wait-for-reply logic):

```typescript
async confirmSend(input: { draftId: string; timeout?: number }): Promise<ToolResult> {
  const activeMeet = meetState;
  if (!activeMeet) {
    return errorResult("No active meet session");
  }

  if (!activeMeet.stagedDraft) {
    return errorResult("No staged draft to send");
  }

  if (activeMeet.stagedDraft.id !== input.draftId) {
    return errorResult("Draft ID mismatch — the draft may have been replaced");
  }

  const message = activeMeet.stagedDraft.message;
  activeMeet.stagedDraft = null;

  // --- begin: actual send (extracted from old sendAndWait) ---
  const ws = activeMeet.ws;
  if (!ws || ws.readyState !== 1) {
    clearState();
    return errorResult("WebSocket not connected");
  }

  const timeout = input.timeout ?? 120;
  const payload = createMessagePayload(activeMeet, message);

  const result = await new Promise<PendingReplyResult>((resolve) => {
    const finish = (r: PendingReplyResult) => {
      clearTimeout(timer);
      activeMeet.pendingReply = null;
      resolve(r);
    };

    activeMeet.pendingReply = { resolve: finish };

    const timer = setTimeout(
      () => finish({ content: null, reason: "timeout" }),
      timeout * 1000,
    );

    try {
      ws.send(JSON.stringify(payload));
    } catch {
      finish({ content: null, reason: "disconnected" });
    }
  });

  if (result.error) {
    return errorResult(
      `Protocol error (${result.error.code}): ${result.error.message}`,
    );
  }

  if (result.content !== null) {
    return textResult({ reply: result.content, status: "ok", queuedMessages: [] });
  }

  const reason = result.reason ?? "unknown";
  if (reason === "timeout" || reason === "disconnected") {
    clearState();
  }
  return textResult({ reply: null, status: "ended", reason });
  // --- end: actual send ---
},
```

- [ ] **Step 3: Implement reviseDraft**

```typescript
async reviseDraft(input: { draftId: string; revisedMessage: string }): Promise<ToolResult> {
  const activeMeet = meetState;
  if (!activeMeet) {
    return errorResult("No active meet session");
  }

  if (!activeMeet.stagedDraft) {
    return errorResult("No staged draft to revise");
  }

  if (activeMeet.stagedDraft.id !== input.draftId) {
    return errorResult("Draft ID mismatch — the draft may have been replaced");
  }

  activeMeet.stagedDraft.message = input.revisedMessage;

  return textResult({
    status: "staged",
    draftId: activeMeet.stagedDraft.id,
    message: input.revisedMessage,
    originalDraft: activeMeet.stagedDraft.originalDraft,
  });
},
```

- [ ] **Step 4: Remove old methods**

Delete the `stageReply`, `sendStaged`, `reviseStaged`, and `joinMeet` methods from the controller. Also remove `joinMeet` from the `createMeetController` return object.

- [ ] **Step 5: Update the return object of createMeetController**

The return object should export:

```typescript
return {
  createMeet,
  hostMeet,
  guestMeet,
  sendAndWait,
  confirmSend,
  reviseDraft,
  endMeet,
  getMeetState: () => meetState,
};
```

- [ ] **Step 6: Verify the file compiles**

Run: `cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state && bunx tsc --noEmit -p packages/mcp-server/tsconfig.json`
Expected: Type errors from tests (expected), but no errors from controller.ts or client.ts.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/controller.ts
git commit -m "feat: rewrite sendAndWait to stage-only, add confirmSend and reviseDraft"
```

---

### Task 3: Update tool registration in index.ts

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Remove old tool registrations and add new ones**

Replace the tool registration section. Remove `join_meet`, `stage_reply`, `send_staged`, `revise_staged`. Update `send_and_wait`. Add `confirm_send` and `revise_draft`.

The updated Zod schemas:

```typescript
const sendAndWaitInputSchema = z.object({
  message: z.string().describe("The message to stage for review before sending"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Timeout in seconds for waiting after confirm_send (default: 120)"),
});

const confirmSendInputSchema = z.object({
  draftId: z.string().describe("The draftId from the send_and_wait staging result"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Timeout in seconds to wait for the other participant's reply (default: 120)"),
});

const reviseDraftInputSchema = z.object({
  draftId: z.string().describe("The draftId from the send_and_wait staging result"),
  revisedMessage: z.string().describe("The updated message content"),
});
```

- [ ] **Step 2: Update send_and_wait tool description**

```typescript
server.registerTool("send_and_wait", {
  description:
    "Stage a draft message for review. Does NOT send immediately. " +
    "The draft is shown to the human for approval. After staging, wait approximately 5 seconds " +
    "(as indicated by holdSeconds in the response), then call confirm_send to deliver it. " +
    "If the human says anything during the hold (edit request, feedback, 'change X'), " +
    "use revise_draft instead of confirm_send. " +
    "If the human says 'send it' or similar, call confirm_send immediately without waiting.",
  inputSchema: sendAndWaitInputSchema,
  annotations: { readOnlyHint: false },
}, async (input) => controller.sendAndWait(input));
```

- [ ] **Step 3: Register confirm_send**

```typescript
server.registerTool("confirm_send", {
  description:
    "Send the staged draft and wait for the other participant's reply. " +
    "Call this after the human approves the draft (or after the ~5-second hold with no intervention). " +
    "Returns the other participant's reply message.",
  inputSchema: confirmSendInputSchema,
  annotations: { readOnlyHint: false },
}, async (input) => controller.confirmSend(input));
```

- [ ] **Step 4: Register revise_draft**

```typescript
server.registerTool("revise_draft", {
  description:
    "Revise the staged draft content. Use this when the human wants changes before sending. " +
    "After revising, show the updated draft to the human and wait for approval before calling confirm_send.",
  inputSchema: reviseDraftInputSchema,
  annotations: { readOnlyHint: false },
}, async (input) => controller.reviseDraft(input));
```

- [ ] **Step 5: Remove old schemas**

Delete `stageReplyInputSchema`, `sendStagedInputSchema`, `reviseStagedInputSchema`, `joinMeetInputSchema` and their tool registrations.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "feat: register confirm_send and revise_draft tools, update send_and_wait description"
```

---

### Task 4: Update host_meet and guest_meet tool descriptions for auto-join

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Update host_meet description**

```typescript
server.registerTool("host_meet", {
  description:
    "Claim the host participant link and connect this MCP session as the host. " +
    "The participantLink is a URL matching the pattern: innies.live/j/<stem>.1 " +
    "(or any AgentMeets server URL ending in .1). " +
    "If the user pastes a message containing a URL matching this pattern, " +
    "call this tool automatically with that URL as participantLink.",
  inputSchema: hostMeetInputSchema,
  annotations: { readOnlyHint: false },
}, async (input) => controller.hostMeet(input));
```

- [ ] **Step 2: Update guest_meet description**

```typescript
server.registerTool("guest_meet", {
  description:
    "Claim the guest participant invite link and connect this MCP session as the guest. " +
    "The participantLink is a URL matching the pattern: innies.live/j/<stem>.2 " +
    "(or any AgentMeets server URL ending in .2). " +
    "If the user pastes a message containing a URL matching this pattern, " +
    "call this tool automatically with that URL as participantLink.",
  inputSchema: guestMeetInputSchema,
  annotations: { readOnlyHint: false },
}, async (input) => controller.guestMeet(input));
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "feat: update host_meet/guest_meet descriptions for paste-to-join auto-detection"
```

---

### Task 5: Write tests for new staging flow

**Files:**
- Modify: `packages/mcp-server/src/controller-staged.test.ts` (rewrite)
- Modify: `packages/mcp-server/src/controller.test.ts` (update sendAndWait test)

- [ ] **Step 1: Rewrite controller-staged.test.ts**

Replace the entire file. The `FakeWebSocket` class and `parseToolResult` helper stay the same. The `createConnectedController` helper stays the same. The tests change to use the new method names:

```typescript
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
```

- [ ] **Step 2: Update controller.test.ts sendAndWait assertion**

In `packages/mcp-server/src/controller.test.ts`, the test "host_meet claims the participant link and restores send_and_wait/end_meet" (line 74) calls `controller.sendAndWait()` and expects it to actually send. Since `sendAndWait` now stages instead, update the test to use the new two-step flow:

Replace the section starting at line 186 (`const replyPromise = controller.sendAndWait(...)`) through line 228 (`expect(JSON.parse(hostSocket.sent[1]!)).toEqual({ type: "end" })`):

```typescript
    // Stage a draft
    const stageResult = parseToolResult(
      await controller.sendAndWait({
        message: "What changed?",
        timeout: 1,
      }),
    );
    expect(stageResult.status).toBe("staged");
    expect(stageResult.holdSeconds).toBe(5);
    const draftId = stageResult.draftId as string;

    // Confirm send
    const replyPromise = controller.confirmSend({
      draftId,
      timeout: 1,
    });

    // Wait a tick for the send to execute
    await new Promise((r) => setTimeout(r, 10));

    const outboundMessage = JSON.parse(hostSocket.sent[0]!) as {
      type: string;
      clientMessageId: string;
      replyToMessageId: number | null;
      content: string;
    };
    expect(outboundMessage).toMatchObject({
      type: "message",
      replyToMessageId: null,
      content: "What changed?",
    });

    hostSocket.emitMessage({
      type: "ack",
      messageId: 1,
      clientMessageId: outboundMessage.clientMessageId,
      replyToMessageId: null,
      createdAt: "2026-03-25T18:12:01.000Z",
    });
    hostSocket.emitMessage({
      type: "message",
      messageId: 2,
      sender: "guest",
      clientMessageId: "guest-reply-1",
      replyToMessageId: 1,
      content: "The invite claim worked.",
      createdAt: "2026-03-25T18:12:02.000Z",
    });

    expect(parseToolResult(await replyPromise)).toMatchObject({
      reply: "The invite claim worked.",
      status: "ok",
    });

    expect(parseToolResult(await controller.endMeet())).toEqual({
      status: "ended",
    });
    expect(JSON.parse(hostSocket.sent[1]!)).toEqual({ type: "end" });
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state && bun test packages/mcp-server`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/controller-staged.test.ts packages/mcp-server/src/controller.test.ts
git commit -m "test: rewrite staging tests for mandatory staging flow (send_and_wait → confirm_send)"
```

---

## Workstream B: Server Hardening

These tasks harden the Hono server for production deployment.

### Task 6: Add CORS middleware

**Files:**
- Create: `packages/server/src/middleware/cors.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create CORS middleware**

Create `packages/server/src/middleware/cors.ts`:

```typescript
import { cors } from "hono/cors";

export function corsMiddleware() {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:3001"];

  return cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Idempotency-Key"],
    maxAge: 86400,
  });
}
```

- [ ] **Step 2: Wire CORS into the server**

In `packages/server/src/index.ts`, add after creating the Hono app:

```typescript
import { corsMiddleware } from "./middleware/cors.js";
```

Then after `const app = new Hono();` add:

```typescript
app.use("*", corsMiddleware());
```

- [ ] **Step 3: Run existing server tests**

Run: `cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state && bun test packages/server`
Expected: All pass (CORS middleware shouldn't break anything).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/middleware/cors.ts packages/server/src/index.ts
git commit -m "feat: add CORS middleware with configurable origins"
```

---

### Task 7: Add request logging middleware

**Files:**
- Create: `packages/server/src/middleware/logger.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create logger middleware**

Create `packages/server/src/middleware/logger.ts`:

```typescript
import type { MiddlewareHandler } from "hono";

export function requestLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;
    console.log(`${method} ${path} ${status} ${duration}ms`);
  };
}
```

- [ ] **Step 2: Wire logger into the server**

In `packages/server/src/index.ts`, add:

```typescript
import { requestLogger } from "./middleware/logger.js";
```

Then after the CORS middleware line, add:

```typescript
app.use("*", requestLogger());
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/middleware/logger.ts packages/server/src/index.ts
git commit -m "feat: add request logging middleware"
```

---

### Task 8: Add graceful shutdown handler

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add shutdown handler**

At the bottom of `packages/server/src/index.ts`, after the server creation, add:

```typescript
function shutdown() {
  console.log("Shutting down...");
  roomManager.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Note: This requires `roomManager` and `server` to be in scope. Restructure the bottom of the file:

```typescript
const port = Number(process.env.PORT) || 3000;
const { server, roomManager } = createServer(port);
console.log(`AgentMeets server listening on port ${server.port}`);

function shutdown() {
  console.log("Shutting down...");
  roomManager.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat: add graceful shutdown on SIGTERM/SIGINT"
```

---

### Task 9: Add DB cleanup for expired rooms

**Files:**
- Create: `packages/server/src/db/cleanup.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create cleanup module**

Create `packages/server/src/db/cleanup.ts`:

```typescript
import { Database } from "bun:sqlite";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function sweepExpiredRooms(db: Database): number {
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const result = db.run(
    `DELETE FROM rooms WHERE status IN ('closed', 'expired') AND created_at < ?`,
    [cutoff],
  );
  return result.changes;
}

export function startCleanupInterval(db: Database): Timer {
  sweepExpiredRooms(db);
  const timer = setInterval(() => sweepExpiredRooms(db), CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
```

- [ ] **Step 2: Wire cleanup into server startup**

In `packages/server/src/index.ts`, inside `createServer()`, after creating the database:

```typescript
import { startCleanupInterval } from "./db/cleanup.js";
```

After `const db = createDatabase(...)`:

```typescript
startCleanupInterval(db);
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/db/cleanup.ts packages/server/src/index.ts
git commit -m "feat: add periodic cleanup of expired rooms older than 24h"
```

---

### Task 10: Add opening message size limit

**Files:**
- Modify: `packages/server/src/routes/rooms.ts`

- [ ] **Step 1: Find the POST /rooms handler**

Read `packages/server/src/routes/rooms.ts` to find the room creation route.

- [ ] **Step 2: Add size limit validation**

At the top of the POST `/rooms` handler, before processing the body, add:

```typescript
const body = await c.req.json();
const openingMessage = body.openingMessage;

if (typeof openingMessage !== "string" || openingMessage.trim().length === 0) {
  return c.json({ error: "openingMessage is required" }, 400);
}

if (openingMessage.length > 10_000) {
  return c.json({ error: "openingMessage exceeds 10,000 character limit" }, 413);
}
```

If the handler already validates `openingMessage`, add the size check after the existing validation.

- [ ] **Step 3: Run server tests**

Run: `cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state && bun test packages/server`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/rooms.ts
git commit -m "feat: add 10KB size limit on opening messages"
```

---

## Workstream C: UI + Deployment

### Task 11: Verify and fix invite landing page copy

**Files:**
- Read: `packages/server/src/routes/invites.ts` (already verified in exploration)

- [ ] **Step 1: Verify landing page text**

The landing page at `packages/server/src/routes/invites.ts` already says:
- "Paste this invite into an existing Claude Code or Codex session." ✅
- "This browser cannot join the room." ✅

No changes needed. Mark SCOPE.md items 8.9 and 8.10 as DONE.

- [ ] **Step 2: Commit scope update**

```bash
git add SCOPE.md
git commit -m "docs: verify invite landing page copy matches spec (8.9, 8.10 DONE)"
```

---

### Task 12: Add CI test workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create test workflow**

Create `.github/workflows/test.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add GitHub Actions test workflow"
```

---

### Task 13: Add Fly.io deployment config for server

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Create fly.toml**

```toml
app = "agentmeets"
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"
  CORS_ORIGINS = "https://innies.live,https://www.innies.live"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

[mounts]
  source = "agentmeets_data"
  destination = "/data"
```

- [ ] **Step 2: Commit**

```bash
git add fly.toml
git commit -m "deploy: add Fly.io config for server deployment"
```

---

### Task 14: Add Vercel deployment config for UI

**Files:**
- Create: `packages/ui/vercel.json`

- [ ] **Step 1: Create vercel.json**

```json
{
  "framework": "nextjs",
  "buildCommand": "bun run build",
  "installCommand": "bun install",
  "env": {
    "AGENTMEETS_SERVER_URL": "https://agentmeets.fly.dev"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/vercel.json
git commit -m "deploy: add Vercel config for UI deployment"
```

---

## Workstream D: Testing + Scope Updates

These tasks depend on Workstreams A and B being complete.

### Task 15: Run all tests and fix failures

**Files:**
- Various (depends on failures)

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/dylanvu/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state
bun test
```

- [ ] **Step 2: Fix any failures**

Address each test failure. Common issues:
- Old method names (`stageReply`, `sendStaged`, `reviseStaged`, `joinMeet`) referenced anywhere
- `index.test.ts` may reference removed tools

- [ ] **Step 3: Run smoke tests**

```bash
bun run smoke:full
bun run smoke:packages
```

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from mandatory staging migration"
```

---

### Task 16: Update SCOPE.md with new statuses

**Files:**
- Modify: `SCOPE.md`

- [ ] **Step 1: Update all requirement statuses**

After all workstreams complete, update SCOPE.md. The expected status changes:

**Section 3 (Same-Session Bootstrap):**
- 3.1: DONE (tool descriptions handle auto-join for Claude Code)
- 3.2: DONE (same mechanism works for Codex)
- 3.3: DONE (tool descriptions replace regex-based detection)
- 3.4: DONE (no manual helper command needed)
- 3.5: N/A (session-helper not used in MCP flow)
- 3.6: DONE (tool result is the confirmation, not helper-rendered)
- 3.7: DONE (tool result is the error surface)
- 3.8: DONE (tool result IS the status surface)

**Section 4 (Conversation Runtime):**
- 4.1: DONE (confirm_send blocks and returns reply)

**Section 5 (Auto-Send Hold):**
- 5.1: DONE (holdSeconds in tool result instructs agent to wait)
- 5.2: DONE (agent presents the staged draft as the status)
- 5.3: DONE (human says anything → agent enters draft mode)

**Section 6 (Draft Mode):**
- 6.1: DONE (human says "e" or anything → agent uses revise_draft)
- 6.2: DONE (originalDraft + message in StagedDraft)
- 6.3: DONE (confirm_send sends working draft)
- 6.4: DONE (agent re-stages via send_and_wait)
- 6.5: DONE (agent calls revise_draft with originalDraft)
- 6.6: DONE (end_meet)
- 6.7: DONE (agent interprets free-form as feedback)
- 6.8: DONE (tool result shown in MCP client)
- 6.9: DONE (replaced by send_and_wait/confirm_send/revise_draft)

**Section 7 (Pre-Activation):**
- 7.3: DONE (staging works before activation)
- 7.4: DONE (confirm_send returns staged_pending_activation)
- 7.5: DONE (tool result IS the UX)

**Section 8 (Browser UI):**
- 8.9: DONE (verified)
- 8.10: DONE (verified)

**Section 9 (Room Lifecycle):**
- 9.6: DONE (if 410 bug was already fixed — otherwise note status from investigation)

**Section 10 (Mixed-Client):**
- 10.1: DONE (standard MCP tools work in Claude Code)
- 10.2: NEEDS TESTING (standard MCP tools should work in Codex)
- 10.3: NEEDS TESTING
- 10.4: DONE (same tool interface for all clients)

**Section 11 (Deployment):**
- 11.2: DONE (Fly.io config)
- 11.3: DONE (Vercel config)
- 11.6: DONE (CI workflow)
- 11.7: DONE (CORS middleware)
- 11.8: DONE (graceful shutdown)
- 11.9: DONE (request logging)
- 11.10: DONE (DB cleanup)

- [ ] **Step 2: Update summary table**

- [ ] **Step 3: Commit**

```bash
git add SCOPE.md
git commit -m "docs: update SCOPE.md — mark completed requirements from mandatory staging implementation"
```

---

### Task 17: Mixed-client smoke test documentation

**Files:**
- Create: `docs/smoke-test-checklist.md`

- [ ] **Step 1: Create smoke test checklist**

```markdown
# Mixed-Client Smoke Test Checklist

## Setup
- [ ] Server running (local or deployed)
- [ ] MCP server package installed in both clients

## Test Matrix

### CC ↔ CC (Claude Code ↔ Claude Code)
- [ ] Host creates room via create_meet
- [ ] Host pastes host link → auto-calls host_meet
- [ ] Guest pastes guest link → auto-calls guest_meet
- [ ] Host sends message via send_and_wait → confirm_send
- [ ] Guest receives message, responds
- [ ] Host revises a draft via revise_draft before sending
- [ ] Human interrupts during hold, edits message
- [ ] end_meet closes cleanly

### CC ↔ Codex
- [ ] Same flow as above, one side in Codex

### Codex ↔ Codex
- [ ] Same flow as above, both sides in Codex

### Codex ↔ CC
- [ ] Same flow as above, reversed roles
```

- [ ] **Step 2: Commit**

```bash
git add docs/smoke-test-checklist.md
git commit -m "docs: add mixed-client smoke test checklist"
```

---

## Critical Files

| File | Role |
|------|------|
| `packages/mcp-server/src/controller.ts` | MeetController — rewrite sendAndWait, add confirmSend, reviseDraft |
| `packages/mcp-server/src/client.ts` | StagedDraft type — add originalDraft |
| `packages/mcp-server/src/index.ts` | MCP tool registration — swap tools, update descriptions |
| `packages/mcp-server/src/controller-staged.test.ts` | Staging flow tests |
| `packages/mcp-server/src/controller.test.ts` | Existing tests — update for staging |
| `packages/server/src/index.ts` | Server entry — add CORS, logging, shutdown, cleanup |
| `packages/server/src/middleware/cors.ts` | CORS middleware (new) |
| `packages/server/src/middleware/logger.ts` | Request logger (new) |
| `packages/server/src/db/cleanup.ts` | Expired room sweeper (new) |
| `packages/server/src/routes/rooms.ts` | Size limit on opening messages |
| `.github/workflows/test.yml` | CI test workflow (new) |
| `fly.toml` | Fly.io server deployment config (new) |
| `packages/ui/vercel.json` | Vercel UI deployment config (new) |
| `SCOPE.md` | Requirement tracker — update statuses |

## Verification

1. `bun test` passes (all packages)
2. `bun run smoke:full` passes
3. Staging flow works: send_and_wait → revise_draft → confirm_send round-trip
4. Tool descriptions trigger auto-join when pasting innies.live links
5. CORS headers present on server responses
6. Server logs requests to stdout
7. SIGTERM gracefully shuts down
8. Expired rooms cleaned up after 24h
9. CI workflow runs on PR
