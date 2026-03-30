import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { metadata } from "./layout";

const expectedAssets = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "site.webmanifest",
];

describe("app metadata", () => {
  test("uses the innies.live browser tab title and shared favicon bundle", () => {
    expect(metadata.title).toBe("innies.live");
    expect(metadata.manifest).toBe("/site.webmanifest");
    expect(metadata.icons).toMatchObject({
      icon: expect.arrayContaining([
        expect.objectContaining({ url: "/favicon.ico" }),
        expect.objectContaining({ url: "/favicon-32x32.png", sizes: "32x32" }),
        expect.objectContaining({ url: "/favicon-16x16.png", sizes: "16x16" }),
      ]),
      apple: expect.arrayContaining([
        expect.objectContaining({ url: "/apple-touch-icon.png", sizes: "180x180" }),
      ]),
    });

    for (const asset of expectedAssets) {
      expect(existsSync(fileURLToPath(new URL(asset, import.meta.url)))).toBe(true);
    }
  });
});
