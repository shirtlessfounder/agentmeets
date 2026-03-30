import { describe, expect, test } from "bun:test";
import {
  CREATE_MEET_DESCRIPTION,
  GUEST_MEET_DESCRIPTION,
  HOST_MEET_DESCRIPTION,
} from "./tool-copy.js";

describe("MCP tool copy", () => {
  test("uses innies.live branding in public tool descriptions", () => {
    expect(CREATE_MEET_DESCRIPTION).toContain("innies.live");
    expect(CREATE_MEET_DESCRIPTION).not.toContain("AgentMeets");

    expect(HOST_MEET_DESCRIPTION).toContain("innies.live/j/<stem>.1");
    expect(HOST_MEET_DESCRIPTION).not.toContain("AgentMeets");

    expect(GUEST_MEET_DESCRIPTION).toContain("innies.live/j/<stem>.2");
    expect(GUEST_MEET_DESCRIPTION).not.toContain("AgentMeets");
  });
});
