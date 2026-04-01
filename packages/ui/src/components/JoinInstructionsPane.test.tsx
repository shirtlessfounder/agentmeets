import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildGuestInstruction,
  buildHostInstruction,
  JoinInstructionsPane,
} from "./JoinInstructionsPane";

describe("JoinInstructionsPane", () => {
  test("renders setup, restart, and durable invite-copy steps", () => {
    const markup = renderToStaticMarkup(
      <JoinInstructionsPane
        openingMessage="Review the API transport failure."
        room={{
          roomId: "room_123",
          roomStem: "room_123",
          hostAgentLink: "https://api.innies.live/j/room_123.1",
          guestAgentLink: "https://api.innies.live/j/room_123.2",
          inviteExpiresAt: "2026-03-31T17:00:00.000Z",
          status: "waiting_for_join",
        }}
      />,
    );

    expect(markup).toContain("1. Run in your terminal:");
    expect(markup).toContain("2. Restart your Claude Code or Codex session");
    expect(markup).toContain("3. Copy and send the invite instructions below");
    expect(markup).toContain("YOUR AGENT (HOST)");
    expect(markup).toContain("OTHER AGENT (GUEST)");
    expect(markup).toContain("stays available until one of the agents explicitly ends it");
  });

  test("renders the copy-send step before the opening message preview", () => {
    const markup = renderToStaticMarkup(
      <JoinInstructionsPane
        openingMessage="Review the API transport failure."
        room={{
          roomId: "room_123",
          roomStem: "room_123",
          hostAgentLink: "https://api.innies.live/j/room_123.1",
          guestAgentLink: "https://api.innies.live/j/room_123.2",
          inviteExpiresAt: "2026-03-31T17:00:00.000Z",
          status: "waiting_for_join",
        }}
      />,
    );

    expect(markup.indexOf("3. Copy and send the invite instructions below")).toBeLessThan(
      markup.indexOf("Opening Message"),
    );
  });

  test("builds invite-aware host and guest clipboard instructions without join commands", () => {
    const hostInstruction = buildHostInstruction("https://api.innies.live/j/room_123.1");
    const guestInstruction = buildGuestInstruction("https://api.innies.live/j/room_123.2");

    expect(hostInstruction).toContain("Tell your agent to join this chat: https://api.innies.live/j/room_123.1");
    expect(hostInstruction).toContain("The opening message has already been sent.");
    expect(hostInstruction).toContain("Wait for the guest reply first.");
    expect(hostInstruction).not.toContain("join https://");

    expect(guestInstruction).toContain("Tell the other agent to join this chat: https://api.innies.live/j/room_123.2");
    expect(guestInstruction).toContain("Read the host's opening message after joining.");
    expect(guestInstruction).toContain("Reply to it.");
    expect(guestInstruction).not.toContain("join https://");
  });
});
