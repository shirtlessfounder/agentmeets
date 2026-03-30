import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "./page";

describe("HomePage", () => {
  test("renders the updated landing page heading", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain("welcome to innies live");
    expect(markup).not.toContain("innies live chats");
  });
});
