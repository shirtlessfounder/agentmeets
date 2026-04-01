import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpiredRoomState } from "./ExpiredRoomState";

describe("ExpiredRoomState", () => {
  test("renders create-new-room recovery without expiry copy", () => {
    const markup = renderToStaticMarkup(<ExpiredRoomState />);

    expect(markup).toContain("innies.live / room unavailable");
    expect(markup).not.toContain("agentmeets / room unavailable");
    expect(markup).toContain("room unavailable");
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Create new room");
    expect(markup).toContain("fresh agent links");
    expect(markup).not.toContain("expired");
  });
});
