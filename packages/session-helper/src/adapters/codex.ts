import type {
  DraftCommand,
  SessionRuntimeAdapter,
  SessionTranscriptMessage,
} from "./types.js";

const DEFAULT_DRAFT_COMMAND = "/draft <message>";
const DEFAULT_DRAFT_CONTROLS = ["/send", "/regenerate", "/revert", "/end"];

export interface CodexAdapterOptions {
  writeToPty: (chunk: string) => void | Promise<void>;
  initialTranscript?: SessionTranscriptMessage[];
  draftCommand?: string;
}

export interface CodexRemoteMessage {
  remoteRole: "host" | "guest";
  content: string;
}

export interface CodexDraftState {
  originalDraft: string;
  workingDraft: string;
}

export class CodexAdapter implements SessionRuntimeAdapter {
  #transcript: SessionTranscriptMessage[];
  #writeToPty: CodexAdapterOptions["writeToPty"];
  #draftCommand: string;
  #draftState: CodexDraftState | null = null;

  constructor({
    writeToPty,
    initialTranscript = [],
    draftCommand = DEFAULT_DRAFT_COMMAND,
  }: CodexAdapterOptions) {
    this.#writeToPty = writeToPty;
    this.#draftCommand = draftCommand;
    this.#transcript = initialTranscript.map(cloneMessage);
  }

  async getTranscript(): Promise<SessionTranscriptMessage[]> {
    return this.#transcript.map(cloneMessage);
  }

  async appendOutboundAssistantMessage(content: string): Promise<void> {
    this.#transcript.push({
      role: "assistant",
      content,
    });
  }

  async injectRemoteMessage({
    remoteRole,
    content,
  }: CodexRemoteMessage): Promise<void> {
    this.#transcript.push({
      role: "user",
      content,
    });

    await this.#writeToPty(
      [
        "[agentmeets codex remote-message]",
        `remote_role=${remoteRole}`,
        `draft_command=${this.#draftCommand}`,
        "---",
        content,
        "",
      ].join("\n"),
    );
  }

  async enterDraftMode({
    originalDraft,
    workingDraft,
  }: CodexDraftState): Promise<void> {
    await this.renderDraftMode({
      originalDraft,
      workingDraft,
      controls: DEFAULT_DRAFT_CONTROLS,
    });
  }

  async renderDraftMode({
    originalDraft,
    workingDraft,
    controls,
  }: CodexDraftState & { controls: string[] }): Promise<void> {
    const preservedOriginalDraft =
      this.#draftState?.originalDraft ?? originalDraft;

    this.#draftState = {
      originalDraft: preservedOriginalDraft,
      workingDraft,
    };

    await this.#writeToPty(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        preservedOriginalDraft,
        "workingDraft:",
        workingDraft,
        `controls: ${controls.join(" | ")}`,
        "",
      ].join("\n"),
    );
  }

  async renderLocalSurface(content: string): Promise<void> {
    await this.#writeToPty(content);
  }

  async requestDraftRevision({
    originalDraft,
    workingDraft,
    feedback,
  }: {
    originalDraft: string;
    workingDraft: string;
    feedback: string | null;
  }): Promise<void> {
    await this.#writeToPty(
      [
        "[agentmeets codex revise-draft]",
        "originalDraft:",
        originalDraft,
        "workingDraft:",
        workingDraft,
        "feedback:",
        feedback ?? "(none)",
        `draft_command=${this.#draftCommand}`,
        "",
      ].join("\n"),
    );
  }

  routeDraftCommand(input: string): DraftCommand | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed === "/send") {
      return { kind: "send_draft" };
    }

    if (trimmed === "/regenerate") {
      if (!this.#draftState) {
        return null;
      }

      return {
        kind: "regenerate_draft",
        originalDraft: this.#draftState.originalDraft,
        workingDraft: this.#draftState.workingDraft,
      };
    }

    if (trimmed === "/revert") {
      if (!this.#draftState) {
        return null;
      }

      return { kind: "revert_draft" };
    }

    if (trimmed === "/end") {
      return { kind: "end_session" };
    }

    if (!trimmed.startsWith("/draft")) {
      if (this.#draftState) {
        return {
          kind: "draft_feedback",
          feedback: trimmed,
        };
      }

      return null;
    }

    const content = trimmed.slice("/draft".length).trim();
    if (content.length === 0) {
      return null;
    }

    return {
      kind: "submit_draft",
      content,
    };
  }

  async injectHostReadyPrompt({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<void> {
    await this.#writeReadyPrompt({
      promptKind: "host-ready",
      participantLink,
      connectTool: "host_meet",
    });
  }

  async injectGuestReadyPrompt({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<void> {
    await this.#writeReadyPrompt({
      promptKind: "guest-ready",
      participantLink,
      connectTool: "guest_meet",
    });
  }

  async #writeReadyPrompt({
    promptKind,
    participantLink,
    connectTool,
  }: {
    promptKind: "host-ready" | "guest-ready";
    participantLink: string;
    connectTool: "host_meet" | "guest_meet";
  }): Promise<void> {
    await this.#writeToPty(
      [
        `[agentmeets codex ${promptKind}]`,
        `participant_link=${participantLink}`,
        `connect_tool=${connectTool}`,
        `connect_args={"participantLink":"${participantLink}"}`,
        `draft_command=${this.#draftCommand}`,
        "controls=/regenerate|/end",
        "",
      ].join("\n"),
    );
  }
}

function cloneMessage(
  message: SessionTranscriptMessage,
): SessionTranscriptMessage {
  return { ...message };
}
