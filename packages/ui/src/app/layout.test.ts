import { describe, expect, test } from "bun:test";
import { metadata } from "./layout";

describe("app metadata", () => {
  test("uses the innies.live browser tab title", () => {
    expect(metadata.title).toBe("innies.live");
  });
});
