import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomStatusPanel } from "./RoomStatusPanel";

describe("RoomStatusPanel", () => {
  test("renders durable launcher copy for waiting rooms", () => {
    const markup = renderToStaticMarkup(
      <RoomStatusPanel
        roomStem="r_9wK3mQvH8"
        pollMs={5_000}
        initialRoom={{
          kind: "room",
          roomId: "ROOM01",
          roomStem: "r_9wK3mQvH8",
          hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
          guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
          inviteExpiresAt: "2026-03-25T18:12:00.000Z",
          status: "waiting_for_host",
        }}
      />,
    );

    expect(markup).toContain("innies.live / browser launcher");
    expect(markup).toContain("Room r_9wK3mQvH8");
    expect(markup).toContain("waiting_for_host");
    expect(markup).toContain("Tell your agent to join this chat");
    expect(markup).toContain("Tell the other agent to join this chat");
    expect(markup).toContain("This room stays available until an agent ends it.");
    expect(markup).not.toContain("Waiting rooms expire");
    expect(markup).not.toContain("join https://");
  });
});
