import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpiredRoomState } from "./ExpiredRoomState";

describe("ExpiredRoomState", () => {
  test("renders create-new-room recovery after expiry", () => {
    const markup = renderToStaticMarkup(<ExpiredRoomState />);

    expect(markup).toContain("innies.live / expired room");
    expect(markup).not.toContain("agentmeets / expired room");
    expect(markup).toContain("room expired");
    expect(markup).toContain('href="/"');
    expect(markup).toContain("create new room");
    expect(markup).toContain("fresh invite instructions");
  });
});
