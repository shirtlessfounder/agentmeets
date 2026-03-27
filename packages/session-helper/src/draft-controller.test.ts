import { describe, expect, test } from "bun:test";

describe("createDraftController", () => {
  test("tracks the active message and enters the hold countdown when a draft arrives", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    const inboundMessage = {
      type: "message" as const,
      messageId: 12,
      sender: "guest" as const,
      clientMessageId: "guest-12",
      replyToMessageId: null,
      content: "Please tighten this summary.",
      createdAt: "2026-03-27 12:00:12",
    };

    expect(controller.processServerMessage(inboundMessage)).toEqual([
      {
        kind: "inbound",
        message: inboundMessage,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "drafting_reply",
      activeMessageId: 12,
      lastReceivedMessageId: 12,
    });

    expect(
      controller.acceptDraft(
        "First draft",
        "2026-03-27T12:00:17.000Z",
      ),
    ).toEqual({
      kind: "draft_prepared",
      activeMessageId: 12,
      originalDraft: "First draft",
      workingDraft: "First draft",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "hold_countdown",
      draftMode: "auto",
      activeMessageId: 12,
      originalDraft: "First draft",
      workingDraft: "First draft",
      countdownEndsAt: "2026-03-27T12:00:17.000Z",
    });
  });

  test("moves from auto to manual draft mode on interruption and preserves originalDraft across revisions", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.processServerMessage({
      type: "message",
      messageId: 13,
      sender: "guest",
      clientMessageId: "guest-13",
      replyToMessageId: null,
      content: "Please tighten this summary.",
      createdAt: "2026-03-27 12:00:13",
    });
    controller.acceptDraft("Initial summary.", "2026-03-27T12:00:18.000Z");

    expect(
      controller.applyCountdownResult({
        kind: "interrupted",
        key: "e",
      }),
    ).toEqual({
      kind: "draft_mode_changed",
      draftMode: "manual",
      reason: "interrupted",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "draft_mode",
      draftMode: "manual",
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
      countdownEndsAt: null,
    });

    expect(
      controller.acceptDraft("Second pass.", null),
    ).toEqual({
      kind: "draft_updated",
      activeMessageId: 13,
      originalDraft: "Initial summary.",
      workingDraft: "Second pass.",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "draft_mode",
      originalDraft: "Initial summary.",
      workingDraft: "Second pass.",
    });

    expect(controller.revertDraft()).toEqual({
      kind: "draft_updated",
      activeMessageId: 13,
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "draft_mode",
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
    });

    expect(controller.resumeAutoMode("2026-03-27T12:00:23.000Z")).toEqual([
      {
        kind: "draft_mode_changed",
        draftMode: "auto",
        reason: "manual_complete",
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "hold_countdown",
      draftMode: "auto",
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
      countdownEndsAt: "2026-03-27T12:00:23.000Z",
    });
  });

  test("auto-sends the current workingDraft after the 5 second hold when the room is active", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.processServerMessage({
      type: "room_active",
    });
    controller.processServerMessage({
      type: "message",
      messageId: 14,
      sender: "guest",
      clientMessageId: "guest-14",
      replyToMessageId: null,
      content: "Please tighten this summary.",
      createdAt: "2026-03-27 12:00:14",
    });
    controller.acceptDraft("First draft", "2026-03-27T12:00:19.000Z");

    const countdownResult = controller.applyCountdownResult({
      kind: "expired",
      durationMs: 5_000,
    });

    expect(countdownResult).toMatchObject({
      kind: "send_requested",
      payload: {
        type: "message",
        replyToMessageId: 14,
        content: "First draft",
      },
    });
    expect(typeof countdownResult.payload.clientMessageId).toBe("string");
    expect(controller.getSnapshot()).toMatchObject({
      status: "sending",
      activeMessageId: 14,
      originalDraft: "First draft",
      workingDraft: "First draft",
      pendingClientMessageId: countdownResult.payload.clientMessageId,
      countdownEndsAt: null,
    });
  });

  test("stages /send before activation and flushes it after room_active", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.processServerMessage({
      type: "message",
      messageId: 15,
      sender: "host",
      clientMessageId: "persisted:15",
      replyToMessageId: null,
      content: "Opening message from the room creator.",
      createdAt: "2026-03-27 12:00:15",
    });
    controller.acceptDraft("First draft", "2026-03-27T12:00:20.000Z");
    controller.applyCountdownResult({
      kind: "interrupted",
      key: "e",
    });

    expect(controller.sendCurrentDraft()).toEqual({
      kind: "staged_pre_activation",
      activeMessageId: 15,
      workingDraft: "First draft",
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "draft_mode",
      draftMode: "manual",
      stagedBeforeActivation: true,
      pendingClientMessageId: null,
    });

    const activatedEvents = controller.processServerMessage({
      type: "room_active",
    });
    expect(activatedEvents).toHaveLength(1);
    expect(activatedEvents[0]).toMatchObject({
      kind: "send_requested",
      payload: {
        type: "message",
        replyToMessageId: 15,
        content: "First draft",
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      status: "sending",
      stagedBeforeActivation: false,
      pendingClientMessageId: activatedEvents[0]?.payload.clientMessageId,
    });
  });

  test("queues inbound while a reply is unresolved and releases it when the ack completes", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.processServerMessage({
      type: "room_active",
    });
    controller.processServerMessage({
      type: "message",
      messageId: 4,
      sender: "guest",
      clientMessageId: "guest-4",
      replyToMessageId: null,
      content: "Please summarize the rollback.",
      createdAt: "2026-03-24 12:00:04",
    });
    controller.acceptDraft("draft reply", "2026-03-27T12:00:09.000Z");
    const sendRequested = controller.applyCountdownResult({
      kind: "expired",
      durationMs: 5_000,
    });

    expect(controller.processServerMessage({
      type: "message",
      messageId: 5,
      sender: "guest",
      clientMessageId: "guest-5",
      replyToMessageId: 4,
      content: "second inbound while ack pending",
      createdAt: "2026-03-24 12:00:05",
    })).toEqual([
      {
        kind: "inbound_queued",
        messageId: 5,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "sending",
      queuedInbound: [
        {
          type: "message",
          messageId: 5,
          sender: "guest",
          clientMessageId: "guest-5",
          replyToMessageId: 4,
          content: "second inbound while ack pending",
          createdAt: "2026-03-24 12:00:05",
        },
      ],
    });

    expect(
      controller.processServerMessage({
        type: "ack",
        messageId: 6,
        clientMessageId: sendRequested.payload.clientMessageId,
        replyToMessageId: 4,
        createdAt: "2026-03-24 12:00:06",
      }),
    ).toEqual([
      {
        kind: "send_completed",
        ackMessageId: 6,
        clientMessageId: sendRequested.payload.clientMessageId,
      },
      {
        kind: "inbound_released",
        message: {
          type: "message",
          messageId: 5,
          sender: "guest",
          clientMessageId: "guest-5",
          replyToMessageId: 4,
          content: "second inbound while ack pending",
          createdAt: "2026-03-24 12:00:05",
        },
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      lastAckedMessageId: 6,
      lastReceivedMessageId: 5,
      status: "drafting_reply",
      activeMessageId: 5,
      queuedInbound: [],
    });
  });

  test("treats ended and error events as terminal while a send is in flight", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.processServerMessage({
      type: "room_active",
    });
    controller.processServerMessage({
      type: "message",
      messageId: 30,
      sender: "guest",
      clientMessageId: "guest-30",
      replyToMessageId: null,
      content: "please tighten this",
      createdAt: "2026-03-27 12:00:30",
    });
    controller.acceptDraft("draft reply", "2026-03-27T12:00:35.000Z");
    const outbound = controller.applyCountdownResult({
      kind: "expired",
      durationMs: 5_000,
    }).payload;

    expect(
      controller.processServerMessage({
        type: "error",
        code: "invalid_message",
        message: "bad payload",
      }),
    ).toEqual([
      {
        kind: "error",
        code: "invalid_message",
        message: "bad payload",
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      terminal: {
        kind: "error",
        code: "invalid_message",
        message: "bad payload",
      },
    });

    const nextController = module.createDraftController({ roomId: "ROOM-456" });
    nextController.processServerMessage({
      type: "room_active",
    });
    nextController.processServerMessage({
      type: "message",
      messageId: 31,
      sender: "guest",
      clientMessageId: "guest-31",
      replyToMessageId: null,
      content: "another inbound",
      createdAt: "2026-03-27 12:00:31",
    });
    nextController.acceptDraft("another draft", "2026-03-27T12:00:36.000Z");
    nextController.applyCountdownResult({
      kind: "expired",
      durationMs: 5_000,
    });

    expect(
      nextController.processServerMessage({
        type: "ended",
        reason: "timeout",
      }),
    ).toEqual([
      {
        kind: "ended",
        reason: "timeout",
      },
    ]);
    expect(nextController.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      terminal: {
        kind: "ended",
        reason: "timeout",
      },
    });

    expect(
      nextController.processServerMessage({
        type: "ack",
        messageId: 9,
        clientMessageId: outbound.clientMessageId,
        replyToMessageId: null,
        createdAt: "2026-03-24 12:00:09",
      }),
    ).toEqual([]);
  });

  test("does not resume auto mode or release queued inbound after a terminal event", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-789" });
    controller.processServerMessage({
      type: "message",
      messageId: 40,
      sender: "guest",
      clientMessageId: "guest-40",
      replyToMessageId: null,
      content: "queued before shutdown",
      createdAt: "2026-03-24 12:00:40",
    });
    controller.acceptDraft("Initial summary.", "2026-03-27T12:00:45.000Z");
    controller.applyCountdownResult({
      kind: "interrupted",
      key: "e",
    });

    const queuedMessage = {
      type: "message" as const,
      messageId: 41,
      sender: "guest" as const,
      clientMessageId: "guest-41",
      replyToMessageId: 40,
      content: "queued before shutdown",
      createdAt: "2026-03-24 12:00:41",
    };

    expect(controller.processServerMessage(queuedMessage)).toEqual([
      {
        kind: "inbound_queued",
        messageId: 41,
      },
    ]);

    expect(
      controller.processServerMessage({
        type: "ended",
        reason: "timeout",
      }),
    ).toEqual([
      {
        kind: "ended",
        reason: "timeout",
      },
    ]);

    expect(controller.resumeAutoMode()).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "ended",
      draftMode: "manual",
      activeMessageId: 40,
      originalDraft: "Initial summary.",
      workingDraft: "Initial summary.",
      queuedInbound: [queuedMessage],
      terminal: {
        kind: "ended",
        reason: "timeout",
      },
    });
  });
});
