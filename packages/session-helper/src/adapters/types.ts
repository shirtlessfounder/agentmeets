export interface DetectedInvite {
  inviteToken: string;
  inviteUrl: string;
}

export interface SessionTranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export type DraftCommand =
  | {
      kind: "submit_draft";
      content: string;
    }
  | {
      kind: "send_draft";
    }
  | {
      kind: "regenerate_draft";
      originalDraft: string;
      workingDraft: string;
    }
  | {
      kind: "revert_draft";
    }
  | {
      kind: "end_session";
    }
  | {
      kind: "draft_feedback";
      feedback: string;
    };

export interface SessionAdapter {
  getTranscript(): Promise<SessionTranscriptMessage[]>;
  appendOutboundAssistantMessage(content: string): Promise<void>;
}

export interface SessionRuntimeAdapter extends SessionAdapter {
  injectRemoteMessage(input: {
    remoteRole: "host" | "guest";
    content: string;
  }): Promise<void>;
  renderLocalSurface(content: string): Promise<void>;
  enterDraftMode(input: {
    originalDraft: string;
    workingDraft: string;
  }): Promise<void>;
  renderDraftMode(input: {
    originalDraft: string;
    workingDraft: string;
    controls: string[];
  }): Promise<void>;
  requestDraftRevision(input: {
    originalDraft: string;
    workingDraft: string;
    feedback: string | null;
  }): Promise<void>;
  routeDraftCommand(input: string): DraftCommand | null;
}
