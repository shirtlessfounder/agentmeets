import {
  createSessionHelperClient,
  type CreateSessionHelperClientOptions,
  type SessionHelperClient,
} from "./client.js";
import { DEFAULT_COUNTDOWN_MS } from "./countdown.js";
import { renderLocalStatus, waitingForFromStatus } from "./local-ui.js";
import type { SessionRuntimeAdapter } from "./adapters/types.js";
import type {
  DraftControllerEvent,
  SessionBootstrapStatus,
  SessionHelperState,
  SessionMessageEvent,
  SessionSender,
  SessionServerMessage,
} from "./protocol.js";

interface WebSocketLike {
  readyState: number;
  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}

export interface RunSessionRuntimeOptions {
  rootDir: string;
  roomId: string;
  wsUrl: string;
  role: SessionSender;
  roomLabel: string;
  initialStatus: SessionBootstrapStatus;
  adapter: SessionRuntimeAdapter;
  webSocketFactory?: (url: string) => WebSocketLike;
  countdownOptions?: CreateSessionHelperClientOptions["countdownOptions"];
}

export interface SessionRuntime {
  client: SessionHelperClient;
  getState(): SessionHelperState;
  handleSessionInput(input: string): Promise<void>;
  handleKeypress(input: string): Promise<void>;
  waitForIdle(): Promise<void>;
  close(): void;
}

export async function runSessionRuntime({
  rootDir,
  roomId,
  wsUrl,
  role,
  roomLabel,
  initialStatus,
  adapter,
  webSocketFactory = (url: string) =>
    new WebSocket(url) as unknown as WebSocketLike,
  countdownOptions,
}: RunSessionRuntimeOptions): Promise<SessionRuntime> {
  const client = await createSessionHelperClient({
    rootDir,
    roomId,
    countdownOptions,
    onEvents(events) {
      return handleEvents(events);
    },
  });
  const holdSeconds = Math.round(
    (countdownOptions?.durationMs ?? DEFAULT_COUNTDOWN_MS) / 1_000,
  );
  const ws = webSocketFactory(wsUrl);
  let pending = Promise.resolve();

  attachListeners(ws);

  try {
    await waitForOpen(ws);
  } catch {
    await adapter.renderLocalSurface(
      renderLocalStatus({
        kind: "failure",
        code: "runtime_failure",
        detail: "WebSocket connection failed",
      }),
    );
    throw new Error("runtime_failure");
  }

  if (initialStatus === "active") {
    await client.processServerMessage({ type: "room_active" });
  }

  await adapter.renderLocalSurface(
    renderLocalStatus({
      kind: "connected",
      role,
      roomLabel,
    }),
  );

  const waitingFor = waitingForFromStatus(initialStatus);
  if (waitingFor) {
    await adapter.renderLocalSurface(
      renderLocalStatus({
        kind: "waiting_for_other_side",
        role,
        roomLabel,
        waitingFor,
      }),
    );
  }

  return {
    client,
    getState() {
      return client.getState();
    },
    async handleSessionInput(input: string) {
      await enqueue(async () => {
        const command = adapter.routeDraftCommand(input);
        if (!command) {
          return;
        }

        switch (command.kind) {
          case "submit_draft":
            await handleEvent(await client.acceptDraft(command.content));
            return;
          case "send_draft":
            await handleEvent(await client.sendCurrentDraft());
            return;
          case "regenerate_draft": {
            const state = client.getState();
            if (state.originalDraft === null) {
              return;
            }

            await adapter.requestDraftRevision({
              originalDraft: state.originalDraft,
              workingDraft: state.workingDraft,
              feedback: null,
            });
            return;
          }
          case "revert_draft":
            await handleEvent(await client.revertDraft());
            return;
          case "draft_feedback": {
            const state = client.getState();
            if (state.originalDraft === null) {
              return;
            }

            await adapter.requestDraftRevision({
              originalDraft: state.originalDraft,
              workingDraft: state.workingDraft,
              feedback: command.feedback,
            });
            return;
          }
          case "end_session":
            ws.send(JSON.stringify({ type: "end" }));
            return;
        }
      });
    },
    async handleKeypress(input: string) {
      await enqueue(async () => {
        await client.handleKeypress(input);
      });
    },
    async waitForIdle() {
      await pending;
      await Promise.resolve();
      if (client.getState().status !== "hold_countdown") {
        await client.waitForIdle();
      } else {
        await Promise.resolve();
        if (client.getState().status !== "hold_countdown") {
          await client.waitForIdle();
        }
      }
      await pending;
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };

  function enqueue(task: () => Promise<void>): Promise<void> {
    const nextTask = pending.then(task, task);
    pending = nextTask.then(
      () => undefined,
      () => undefined,
    );
    return nextTask;
  }

  function attachListeners(socket: WebSocketLike): void {
    socket.addEventListener("message", (event) => {
      void enqueue(async () => {
        let parsed: SessionServerMessage;
        try {
          parsed = JSON.parse(String(event.data)) as SessionServerMessage;
        } catch {
          return;
        }

        if (parsed.type === "message" && parsed.sender === role) {
          await client.processReplayMessage(parsed as SessionMessageEvent);
          return;
        }

        const events = await client.processServerMessage(parsed);
        await handleEvents(events);
      });
    });
  }

  async function handleEvents(events: DraftControllerEvent[]): Promise<void> {
    for (const event of events) {
      await handleEvent(event);
    }
  }

  async function handleEvent(event: DraftControllerEvent): Promise<void> {
    switch (event.kind) {
      case "draft_prepared":
        await adapter.renderLocalSurface(
          renderLocalStatus({
            kind: "hold_countdown",
            secondsRemaining: holdSeconds,
          }),
        );
        return;
      case "draft_updated":
        await renderDraftMode();
        return;
      case "draft_mode_changed":
        if (event.draftMode === "manual") {
          await renderDraftMode();
          return;
        }

        await adapter.renderLocalSurface(
          renderLocalStatus({
            kind: "hold_countdown",
            secondsRemaining: holdSeconds,
          }),
        );
        return;
      case "send_requested":
        ws.send(JSON.stringify(event.payload));
        return;
      case "send_completed":
        return;
      case "staged_pre_activation":
        await adapter.renderLocalSurface(
          renderLocalStatus({
            kind: "staged_pre_activation",
            role,
            roomLabel,
          }),
        );
        await renderDraftMode();
        return;
      case "inbound":
      case "inbound_released":
        await adapter.injectRemoteMessage({
          remoteRole: event.message.sender,
          content: event.message.content,
        });
        return;
      case "inbound_queued":
        return;
      case "error":
        await adapter.renderLocalSurface(
          renderLocalStatus({
            kind: "failure",
            code: "runtime_failure",
            detail: event.message,
          }),
        );
        return;
      case "ended":
        return;
    }
  }

  async function renderDraftMode(): Promise<void> {
    const state = client.getState();
    if (state.originalDraft === null) {
      return;
    }

    await adapter.renderDraftMode({
      originalDraft: state.originalDraft,
      workingDraft: state.workingDraft,
      controls: ["/send", "/regenerate", "/revert", "/end"],
    });
  }
}

function waitForOpen(ws: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) {
      resolve();
      return;
    }

    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });
}
