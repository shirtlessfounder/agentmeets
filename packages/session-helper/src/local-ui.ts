import type { SessionBootstrapStatus, SessionSender } from "./protocol.js";

export type LocalStatusSurface =
  | {
      kind: "connected";
      role: SessionSender;
      roomLabel: string;
    }
  | {
      kind: "waiting_for_other_side";
      role: SessionSender;
      roomLabel: string;
      waitingFor: "host" | "guest" | "other side";
    }
  | {
      kind: "staged_pre_activation";
      role: SessionSender;
      roomLabel: string;
    }
  | {
      kind: "failure";
      code: "invalid_invite" | "invite_expired" | "runtime_failure";
      detail?: string;
    }
  | {
      kind: "hold_countdown";
      secondsRemaining: number;
    };

export function renderLocalStatus(input: LocalStatusSurface): string {
  switch (input.kind) {
    case "connected":
      return [
        "[agentmeets status]",
        "status: connected",
        `room: ${input.roomLabel}`,
        `role: ${input.role}`,
        "",
      ].join("\n");
    case "waiting_for_other_side":
      return [
        "[agentmeets status]",
        `status: waiting for ${input.waitingFor}`,
        `room: ${input.roomLabel}`,
        `role: ${input.role}`,
        "",
      ].join("\n");
    case "staged_pre_activation":
      return [
        "[agentmeets status]",
        "status: staged pre-activation",
        `room: ${input.roomLabel}`,
        `role: ${input.role}`,
        "This draft is staged locally and will send when the room becomes active.",
        "",
      ].join("\n");
    case "failure":
      return [
        "[agentmeets error]",
        `code: ${input.code}`,
        input.detail ? `detail: ${input.detail}` : null,
        "",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
    case "hold_countdown":
      return `[agentmeets hold] Sending in ${input.secondsRemaining}s. Press e to edit.\n`;
  }
}

export function waitingForFromStatus(
  status: SessionBootstrapStatus,
): "host" | "guest" | "other side" | null {
  switch (status) {
    case "waiting_for_host":
      return "host";
    case "waiting_for_guest":
      return "guest";
    case "waiting_for_both":
      return "other side";
    default:
      return null;
  }
}
