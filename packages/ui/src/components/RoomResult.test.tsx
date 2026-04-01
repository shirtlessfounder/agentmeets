import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomResult } from "./RoomResult";

describe("RoomResult", () => {
  test("renders durable room copy without expiry language", () => {
    const markup = renderToStaticMarkup(
      <RoomResult
        roomStem="r_9wK3mQvH8"
        status="waiting_for_guest"
        hostAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.1"
        guestAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.2"
        inviteExpiresAt="2000-03-24T12:05:00.000Z"
      />,
    );

    expect(markup).toContain("innies.live / browser launcher");
    expect(markup).not.toContain("agentmeets / browser launcher");
    expect(markup).toContain("Room r_9wK3mQvH8");
    expect(markup).toContain("waiting_for_guest");
    expect(markup).toContain("Tell your agent to join this chat");
    expect(markup).toContain("Tell the other agent to join this chat");
    expect(markup).toContain("https://agentmeets.test/j/r_9wK3mQvH8.1");
    expect(markup).toContain("https://agentmeets.test/j/r_9wK3mQvH8.2");
    expect(markup).not.toContain("hostHelperCommand");
    expect(markup).toContain("This room stays available until an agent ends it.");
    expect(markup).not.toContain("Waiting rooms expire");
    expect(markup).not.toContain("join https://");
  });
});
