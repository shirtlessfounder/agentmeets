import { randomUUID } from "node:crypto";
import {
  cloneSessionHelperState,
  createInitialSessionHelperState,
  type CountdownResult,
  type DraftControllerEvent,
  type SessionHelperState,
  type SessionMessagePayload,
  type SessionMessageEvent,
  type SessionServerMessage,
  type TerminalState,
} from "./protocol.js";

export interface CreateDraftControllerOptions {
  roomId: string;
  initialState?: SessionHelperState;
}

export interface DraftController {
  getSnapshot(): SessionHelperState;
  resumeAutoMode(countdownEndsAt?: string | null): DraftControllerEvent[];
  applyCountdownResult(result: CountdownResult): DraftControllerEvent;
  observeReplayMessage(message: SessionMessageEvent): void;
  acceptDraft(
    content: string,
    countdownEndsAt?: string | null,
  ): DraftControllerEvent;
  revertDraft(): DraftControllerEvent;
  sendCurrentDraft(): DraftControllerEvent;
  beginSend(content: string): SessionMessagePayload;
  processServerMessage(message: SessionServerMessage): DraftControllerEvent[];
}

export function createDraftController({
  roomId,
  initialState,
}: CreateDraftControllerOptions): DraftController {
  const state = initialState
    ? cloneSessionHelperState(initialState)
    : createInitialSessionHelperState(roomId);

  return {
    getSnapshot() {
      return cloneSessionHelperState(state);
    },
    resumeAutoMode(countdownEndsAt = null) {
      if (state.terminal) {
        return [];
      }

      const events: DraftControllerEvent[] = [];

      if (
        state.status === "draft_mode" &&
        state.activeMessageId !== null &&
        state.originalDraft !== null
      ) {
        state.status = "hold_countdown";
        state.draftMode = "auto";
        state.stagedBeforeActivation = false;
        state.countdownEndsAt = countdownEndsAt;
        events.push({
          kind: "draft_mode_changed",
          draftMode: "auto",
          reason: "manual_complete",
        });
      }

      if (state.activeMessageId === null && !state.pendingClientMessageId) {
        const nextInbound = releaseNextQueuedInbound(state);
        if (nextInbound) {
          events.push(nextInbound);
        }
      }

      return events;
    },
    observeReplayMessage(message) {
      state.lastReceivedMessageId = message.messageId;
    },
    acceptDraft(content, countdownEndsAt = null) {
      if (state.terminal) {
        throw new Error("Cannot draft after terminal event.");
      }

      if (state.activeMessageId === null) {
        throw new Error("Cannot draft without an active inbound message.");
      }

      const originalDraft = state.originalDraft ?? content;
      const nextEventKind =
        state.originalDraft === null ? "draft_prepared" : "draft_updated";

      state.originalDraft = originalDraft;
      state.workingDraft = content;
      state.countdownEndsAt = shouldStayManual(state) ? null : countdownEndsAt;

      if (shouldStayManual(state)) {
        state.status = "draft_mode";
        state.draftMode = "manual";
      } else {
        state.status = "hold_countdown";
        state.draftMode = "auto";
      }

      return {
        kind: nextEventKind,
        activeMessageId: state.activeMessageId,
        originalDraft,
        workingDraft: content,
      };
    },
    revertDraft() {
      if (state.terminal) {
        throw new Error("Cannot revert after terminal event.");
      }

      if (state.activeMessageId === null || state.originalDraft === null) {
        throw new Error("Cannot revert without an active draft.");
      }

      state.workingDraft = state.originalDraft;
      state.status = "draft_mode";
      state.draftMode = "manual";
      state.countdownEndsAt = null;

      return {
        kind: "draft_updated",
        activeMessageId: state.activeMessageId,
        originalDraft: state.originalDraft,
        workingDraft: state.workingDraft,
      };
    },
    applyCountdownResult(result) {
      if (state.terminal) {
        throw new Error("Cannot update countdown after terminal event.");
      }

      if (state.status !== "hold_countdown") {
        return {
          kind: "draft_mode_changed",
          draftMode: state.draftMode,
          reason: "fallback_timeout",
        };
      }

      state.countdownEndsAt = null;

      if (result.kind === "interrupted") {
        state.status = "draft_mode";
        state.draftMode = "manual";
        return {
          kind: "draft_mode_changed",
          draftMode: "manual",
          reason: "interrupted",
        };
      }

      if (state.isRoomActive) {
        return {
          kind: "send_requested",
          payload: createOutboundPayload(state, state.workingDraft),
        };
      }

      state.status = "draft_mode";
      state.draftMode = "manual";
      state.stagedBeforeActivation = true;
      return {
        kind: "staged_pre_activation",
        activeMessageId: state.activeMessageId ?? state.lastReceivedMessageId ?? 0,
        workingDraft: state.workingDraft,
      };
    },
    sendCurrentDraft() {
      if (state.terminal) {
        throw new Error("Cannot send after terminal event.");
      }

      if (state.activeMessageId === null || state.workingDraft.length === 0) {
        throw new Error("Cannot send without an active draft.");
      }

      state.countdownEndsAt = null;

      if (state.isRoomActive) {
        return {
          kind: "send_requested",
          payload: createOutboundPayload(state, state.workingDraft),
        };
      }

      state.status = "draft_mode";
      state.draftMode = "manual";
      state.stagedBeforeActivation = true;
      return {
        kind: "staged_pre_activation",
        activeMessageId: state.activeMessageId,
        workingDraft: state.workingDraft,
      };
    },
    beginSend(content) {
      if (state.terminal) {
        throw new Error("Cannot send after terminal event.");
      }

      if (state.pendingClientMessageId) {
        throw new Error("A send is already awaiting ack.");
      }

      if (state.activeMessageId === null && state.lastReceivedMessageId !== null) {
        state.activeMessageId = state.lastReceivedMessageId;
      }
      if (state.originalDraft === null) {
        state.originalDraft = content;
      }
      state.workingDraft = content;
      return createOutboundPayload(state, content);
    },
    processServerMessage(message) {
      if (state.terminal) {
        return [];
      }

      switch (message.type) {
        case "room_active": {
          state.isRoomActive = true;
          if (
            state.stagedBeforeActivation &&
            state.activeMessageId !== null &&
            state.pendingClientMessageId === null &&
            state.workingDraft.length > 0
          ) {
            state.stagedBeforeActivation = false;
            return [
              {
                kind: "send_requested",
                payload: createOutboundPayload(state, state.workingDraft),
              },
            ];
          }
          return [];
        }
        case "message":
          state.lastReceivedMessageId = message.messageId;
          if (shouldQueueInbound(state)) {
            state.queuedInbound.push({ ...message });
            return [
              {
                kind: "inbound_queued",
                messageId: message.messageId,
              },
            ];
          }

          state.activeMessageId = message.messageId;
          state.status = "drafting_reply";
          state.draftMode = "auto";
          state.originalDraft = null;
          state.workingDraft = "";
          state.stagedBeforeActivation = false;
          state.countdownEndsAt = null;

          return [
            {
              kind: "inbound",
              message: { ...message },
            },
          ];
        case "ack":
          if (state.pendingClientMessageId !== message.clientMessageId) {
            return [];
          }

          state.lastAckedMessageId = message.messageId;
          state.pendingClientMessageId = null;
          state.status = "waiting";
          state.draftMode = "auto";
          state.activeMessageId = null;
          state.originalDraft = null;
          state.workingDraft = "";
          state.stagedBeforeActivation = false;
          state.countdownEndsAt = null;

          const releasedInbound = releaseNextQueuedInbound(state);

          return [
            {
              kind: "send_completed",
              ackMessageId: message.messageId,
              clientMessageId: message.clientMessageId,
            },
            ...(releasedInbound ? [releasedInbound] : []),
          ];
        case "error":
          return finalize(state, {
            kind: "error",
            code: message.code,
            message: message.message,
          });
        case "ended":
          return finalize(state, {
            kind: "ended",
            reason: message.reason,
          });
      }
    },
  };
}

function shouldQueueInbound(state: SessionHelperState): boolean {
  return (
    state.activeMessageId !== null ||
    state.pendingClientMessageId !== null ||
    state.stagedBeforeActivation
  );
}

function shouldStayManual(state: SessionHelperState): boolean {
  return state.status === "draft_mode" || state.draftMode === "manual";
}

function finalize(
  state: SessionHelperState,
  terminal: TerminalState,
): DraftControllerEvent[] {
  state.pendingClientMessageId = null;
  state.countdownEndsAt = null;
  state.status = "ended";
  state.terminal = terminal;
  return [terminal];
}

function releaseNextQueuedInbound(
  state: SessionHelperState,
): DraftControllerEvent | null {
  const nextMessage = state.queuedInbound.shift();
  if (!nextMessage) {
    return null;
  }

  state.activeMessageId = nextMessage.messageId;
  state.status = "drafting_reply";
  state.draftMode = "auto";
  state.originalDraft = null;
  state.workingDraft = "";
  state.stagedBeforeActivation = false;
  state.countdownEndsAt = null;

  return {
    kind: "inbound_released",
    message: { ...nextMessage },
  };
}

function createOutboundPayload(
  state: SessionHelperState,
  content: string,
): SessionMessagePayload {
  const payload: SessionMessagePayload = {
    type: "message",
    clientMessageId: randomUUID(),
    replyToMessageId: state.activeMessageId ?? state.lastReceivedMessageId,
    content,
  };

  state.pendingClientMessageId = payload.clientMessageId;
  state.status = "sending";
  state.draftMode = "auto";
  state.countdownEndsAt = null;
  return payload;
}
