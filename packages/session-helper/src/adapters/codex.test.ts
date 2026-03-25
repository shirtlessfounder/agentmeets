import { describe, expect, test } from "bun:test";

describe("CodexAdapter", () => {
  test("injects remote messages with Codex-specific control prompt formatting", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.injectRemoteMessage({
      remoteRole: "host",
      content: "Confirm the rollback and summarize the root cause.",
    });

    expect(writes).toEqual([
      [
        "[agentmeets codex remote-message]",
        "remote_role=host",
        "draft_command=/draft <message>",
        "---",
        "Confirm the rollback and summarize the root cause.",
        "",
      ].join("\n"),
    ]);
  });

  test("shows draft mode controls including originalDraft while preserving the first draft", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.enterDraftMode({
      originalDraft: "Initial summary for Codex.",
      workingDraft: "Initial summary for Codex.",
    });

    expect(writes[0]).toBe(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        "Initial summary for Codex.",
        "workingDraft:",
        "Initial summary for Codex.",
        "controls: /regenerate | /end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/regenerate")).toEqual({
      kind: "regenerate_draft",
      originalDraft: "Initial summary for Codex.",
      workingDraft: "Initial summary for Codex.",
    });

    await adapter.enterDraftMode({
      originalDraft: "This replacement must be ignored.",
      workingDraft: "Second pass with tighter wording.",
    });

    expect(writes[1]).toBe(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        "Initial summary for Codex.",
        "workingDraft:",
        "Second pass with tighter wording.",
        "controls: /regenerate | /end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/end")).toEqual({
      kind: "end_session",
    });
  });
});

describe("createSessionAdapter", () => {
  test("resolves both claude-code and codex adapters from the CLI", async () => {
    const codexModule = await import("./codex.js").catch(() => null);
    const claudeModule = await import("./claude-code.js").catch(() => null);
    const cliModule = await import("../cli.js").catch(() => null);

    expect(codexModule).not.toBeNull();
    expect(claudeModule).not.toBeNull();
    expect(cliModule).not.toBeNull();
    if (!codexModule || !claudeModule || !cliModule) {
      return;
    }

    const codexAdapter = cliModule.createSessionAdapter({
      adapterName: "codex",
      writeToPty() {},
    });
    const claudeAdapter = cliModule.createSessionAdapter({
      adapterName: "claude-code",
      writeToPty() {},
    });

    expect(codexAdapter).toBeInstanceOf(codexModule.CodexAdapter);
    expect(claudeAdapter).toBeInstanceOf(claudeModule.ClaudeCodeAdapter);
  });
});
