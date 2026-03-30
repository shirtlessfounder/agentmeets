import { describe, expect, test } from "bun:test";
import { STARTUP_LOG_PREFIX } from "./server-copy.js";

describe("server copy", () => {
  test("uses innies.live branding for the startup log prefix", () => {
    expect(STARTUP_LOG_PREFIX).toBe("innies.live server listening on port");
  });
});
