import {
  createCountdown,
  type CountdownController,
  type CreateCountdownOptions,
  DEFAULT_COUNTDOWN_MS,
} from "./countdown.js";
import {
  createDraftController,
  type CreateDraftControllerOptions,
  type DraftController,
} from "./draft-controller.js";
import {
  createStateStore,
  type CreateStateStoreOptions,
  type StateStore,
} from "./state-store.js";
import type {
  CountdownResult,
  DraftControllerEvent,
  SessionHelperState,
  SessionMessageEvent,
  SessionMessagePayload,
  SessionServerMessage,
} from "./protocol.js";

export interface CreateSessionHelperClientOptions {
  rootDir: string;
  roomId: string;
  countdownOptions?: CreateCountdownOptions;
  onEvents?: (events: DraftControllerEvent[]) => void | Promise<void>;
}

export interface SessionHelperClient {
  stateStore: StateStore;
  controller: DraftController;
  getState(): SessionHelperState;
  acceptDraft(content: string): Promise<DraftControllerEvent>;
  revertDraft(): Promise<DraftControllerEvent>;
  sendCurrentDraft(): Promise<DraftControllerEvent>;
  beginSend(content: string): Promise<SessionMessagePayload>;
  applyCountdownResult(result: CountdownResult): Promise<DraftControllerEvent>;
  processReplayMessage(message: SessionMessageEvent): Promise<void>;
  processServerMessage(message: SessionServerMessage): Promise<DraftControllerEvent[]>;
  handleKeypress(input: string): Promise<DraftControllerEvent[]>;
  resumeAutoMode(): Promise<DraftControllerEvent[]>;
  waitForIdle(): Promise<void>;
  reload(): Promise<SessionHelperState>;
}

export async function createSessionHelperClient({
  rootDir,
  roomId,
  countdownOptions,
  onEvents,
}: CreateSessionHelperClientOptions): Promise<SessionHelperClient> {
  const stateStore = createStateStore({ rootDir, roomId });
  const initialState = await stateStore.load();
  const countdownDurationMs = countdownOptions?.durationMs ?? DEFAULT_COUNTDOWN_MS;
  let controller = createDraftController({
    roomId,
    initialState,
  });
  let countdown: CountdownController | null = null;
  let countdownTransition: Promise<DraftControllerEvent[]> = Promise.resolve([]);
  let pendingWork: Promise<void> = Promise.resolve();

  const client: SessionHelperClient = {
    stateStore,
    controller,
    getState() {
      return controller.getSnapshot();
    },
    async acceptDraft(content) {
      const event = await schedule(async () => {
        const nextEvent = controller.acceptDraft(
          content,
          shouldArmCountdown(controller.getSnapshot())
            ? createCountdownEndsAt(countdownDurationMs)
            : null,
        );
        await persist(stateStore, controller);
        return nextEvent;
      });
      armCountdown();
      return event;
    },
    async revertDraft() {
      const event = await schedule(async () => {
        const nextEvent = controller.revertDraft();
        await persist(stateStore, controller);
        return nextEvent;
      });
      return event;
    },
    async sendCurrentDraft() {
      cancelCountdown();
      const event = await schedule(async () => {
        const nextEvent = controller.sendCurrentDraft();
        await persist(stateStore, controller);
        return nextEvent;
      });
      return event;
    },
    async beginSend(content) {
      const payload = controller.beginSend(content);
      await schedule(async () => {
        await persist(stateStore, controller);
      });
      return payload;
    },
    async applyCountdownResult(result) {
      cancelCountdown();
      const event = await schedule(async () => {
        const nextEvent = controller.applyCountdownResult(result);
        await persist(stateStore, controller);
        await emitEvents([nextEvent]);
        return nextEvent;
      });
      return event;
    },
    async processServerMessage(message) {
      const events = await schedule(async () => {
        const nextEvents = controller.processServerMessage(message);
        await persist(stateStore, controller);
        return nextEvents;
      });
      if (controller.getSnapshot().terminal) {
        cancelCountdown();
      }
      return events;
    },
    async processReplayMessage(message) {
      await schedule(async () => {
        controller.observeReplayMessage(message);
        await persist(stateStore, controller);
      });
    },
    async handleKeypress(input) {
      if (!countdown || !countdown.handleKeypress(input)) {
        return [];
      }

      return countdownTransition;
    },
    async resumeAutoMode() {
      const events = await schedule(async () => {
        const nextEvents = controller.resumeAutoMode(
          createCountdownEndsAt(countdownDurationMs),
        );
        await persist(stateStore, controller);
        return nextEvents;
      });
      armCountdown();
      return events;
    },
    async waitForIdle() {
      await pendingWork;
      await countdownTransition;
      await pendingWork;
    },
    async reload() {
      cancelCountdown();
      controller = createDraftController({
        roomId,
        initialState: await stateStore.load(),
      });
      client.controller = controller;
      armCountdown();
      return controller.getSnapshot();
    },
  };

  armCountdown();
  return client;

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    const nextTask = pendingWork.then(task, task);
    pendingWork = nextTask.then(
      () => undefined,
      () => undefined,
    );
    return nextTask;
  }

  function cancelCountdown(): void {
    countdown?.cancel();
    countdown = null;
    countdownTransition = Promise.resolve([]);
  }

  function armCountdown(): void {
    cancelCountdown();

    const snapshot = controller.getSnapshot();
    if (snapshot.status !== "hold_countdown" || snapshot.terminal) {
      return;
    }

    const currentCountdown = createCountdown(countdownOptions);
    countdown = currentCountdown;
      countdownTransition = currentCountdown.result.then((result) =>
      schedule(async () => {
        if (countdown !== currentCountdown) {
          return [];
        }

        const event = controller.applyCountdownResult(result);
        countdown = null;
        await persist(stateStore, controller);
        await emitEvents([event]);
        return [event];
      }),
    );
  }

  async function emitEvents(events: DraftControllerEvent[]): Promise<void> {
    if (!onEvents || events.length === 0) {
      return;
    }

    await onEvents(events);
  }
}

function shouldArmCountdown(state: SessionHelperState): boolean {
  return state.status !== "draft_mode" && state.draftMode !== "manual";
}

function createCountdownEndsAt(durationMs: number): string {
  return new Date(Date.now() + durationMs).toISOString();
}

async function persist(
  stateStore: StateStore,
  controller: DraftController,
): Promise<void> {
  await stateStore.save(controller.getSnapshot());
}

export type {
  CreateDraftControllerOptions,
  CreateStateStoreOptions,
  DraftController,
  StateStore,
};
