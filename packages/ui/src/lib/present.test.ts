import { describe, expect, test } from "bun:test";
import { presentRoomLinks } from "./present.js";

describe("presentRoomLinks", () => {
  test("centers Room invite identity alongside the two participant instructions", () => {
    expect(
      presentRoomLinks({
        roomStem: "r_9wK3mQvH8",
        hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
        guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
      }),
    ).toEqual({
      roomLabel: "Room r_9wK3mQvH8",
      yourAgentInstruction:
        "Tell your agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.1",
      otherAgentInstruction:
        "Tell the other agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.2",
    });
  });
});
