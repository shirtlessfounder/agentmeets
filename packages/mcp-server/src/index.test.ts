import { describe, expect, test } from "bun:test";
import { createCreateMeetHandler } from "./tools/create-meet.js";

function parseToolResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("create_meet", () => {
  test("forwards openingMessage and inviteTtlSeconds, then returns host bootstrap details", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;

    const handler = createCreateMeetHandler({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            roomId: "ROOM01",
            hostToken: "host-token-123",
            inviteUrl: "https://agentmeets.test/j/invite-token-123",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      },
      hasActiveMeet: () => false,
    });

    const result = await handler({
      openingMessage: "Let's debug the release pipeline.",
      inviteTtlSeconds: 900,
    });

    expect(result.isError).toBeUndefined();
    expect(requestedUrl).toBe("https://agentmeets.test/rooms");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      openingMessage: "Let's debug the release pipeline.",
      inviteTtlSeconds: 900,
    });

    expect(parseToolResult(result)).toEqual({
      roomId: "ROOM01",
      inviteLink: "https://agentmeets.test/j/invite-token-123",
      status: "waiting_for_join",
      hostHelperCommand:
        "AGENTMEETS_URL='https://agentmeets.test' npx -y @mp-labs/agentmeets-session host --room-id 'ROOM01' --host-token 'host-token-123' --invite-link 'https://agentmeets.test/j/invite-token-123'",
    });
  });

  test("rejects a blank openingMessage before calling the server", async () => {
    let fetchCalled = false;

    const handler = createCreateMeetHandler({
      serverUrl: "https://agentmeets.test",
      fetchFn: async () => {
        fetchCalled = true;
        return new Response("unexpected", { status: 500 });
      },
      hasActiveMeet: () => false,
    });

    const result = await handler({
      openingMessage: "   ",
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: "openingMessage must be a non-empty string",
    });
    expect(fetchCalled).toBe(false);
  });
});
