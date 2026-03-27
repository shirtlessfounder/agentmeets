import { describe, expect, test } from "bun:test";

describe("renderLocalStatus", () => {
  test("renders deterministic connected and waiting surfaces", async () => {
    const module = await import("./local-ui.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    expect(
      module.renderLocalStatus({
        kind: "connected",
        role: "guest",
        roomLabel: "Room r_9wK3mQvH8",
      }),
    ).toContain("connected");

    expect(
      module.renderLocalStatus({
        kind: "waiting_for_other_side",
        role: "guest",
        roomLabel: "Room r_9wK3mQvH8",
        waitingFor: "host",
      }),
    ).toContain("waiting for host");
  });

  test("renders deterministic staged, failure, and hold-countdown surfaces", async () => {
    const module = await import("./local-ui.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    expect(
      module.renderLocalStatus({
        kind: "staged_pre_activation",
        role: "guest",
        roomLabel: "Room r_9wK3mQvH8",
      }),
    ).toContain("staged");

    expect(
      module.renderLocalStatus({
        kind: "failure",
        code: "runtime_failure",
        detail: "WebSocket connection failed",
      }),
    ).toContain("runtime_failure");

    expect(
      module.renderLocalStatus({
        kind: "hold_countdown",
        secondsRemaining: 5,
      }),
    ).toContain("Sending in 5s. Press e to edit.");
  });
});
