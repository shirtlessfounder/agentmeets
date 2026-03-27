import { describe, expect, test } from "bun:test";

interface TestCliEnvironment {
  env?: Record<string, string | undefined>;
  stdout: {
    write: (chunk: string) => void;
  };
  stderr: {
    write: (chunk: string) => void;
  };
  openTty: () => number;
  writeTty: (fd: number, chunk: string) => void;
  closeTty: (fd: number) => void;
  createAdapter: (options: {
    adapterName: string;
    writeToPty: (chunk: string) => void;
  }) => {
    injectHostReadyPrompt: (input: { participantLink: string }) => Promise<void>;
    injectGuestReadyPrompt: (input: {
      participantLink: string;
    }) => Promise<void>;
  };
  cwd?: () => string;
  bootstrapInviteRuntime?: (input: {
    pastedText: string;
    adapterName: string;
  }) => Promise<{
    roomId: string;
    role: "host" | "guest";
    roomLabel: string;
    status: string;
    wsUrl: string;
  }>;
  createRuntime?: (input: {
    rootDir: string;
    roomId: string;
    role: "host" | "guest";
    roomLabel: string;
    initialStatus: string;
    wsUrl: string;
    adapter: unknown;
  }) => Promise<unknown>;
}

function createTestCliEnvironment() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ttyWrites: string[] = [];
  const adapterCalls: Array<{
    mode: "host" | "guest";
    participantLink: string;
  }> = [];
  const adapterNames: string[] = [];
  const bootstrapCalls: Array<{ pastedText: string; adapterName: string }> = [];
  const runtimeCalls: Array<{
    rootDir: string;
    roomId: string;
    role: "host" | "guest";
    roomLabel: string;
    initialStatus: string;
    wsUrl: string;
  }> = [];

  const environment: TestCliEnvironment = {
    env: {},
    stdout: {
      write(chunk) {
        stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk) {
        stderr.push(chunk);
      },
    },
    openTty() {
      return 99;
    },
    writeTty(_fd, chunk) {
      ttyWrites.push(chunk);
    },
    closeTty() {},
    cwd() {
      return "/tmp/agentmeets-runtime-root";
    },
    createAdapter(options) {
      adapterNames.push(options.adapterName);
      return {
        async injectHostReadyPrompt(input) {
          adapterCalls.push({
            mode: "host",
            participantLink: input.participantLink,
          });
        },
        async injectGuestReadyPrompt(input) {
          adapterCalls.push({
            mode: "guest",
            participantLink: input.participantLink,
          });
        },
      };
    },
    async bootstrapInviteRuntime(input) {
      bootstrapCalls.push(input);
      return {
        roomId: "ROOM-789",
        role: "guest",
        roomLabel: "Room r_9wK3mQvH8",
        status: "waiting_for_host",
        wsUrl: "ws://agentmeets.test/rooms/ROOM-789/ws?token=guest-session-token",
      };
    },
    async createRuntime(input) {
      runtimeCalls.push(input);
      return {};
    },
  };

  return {
    environment,
    stdout,
    stderr,
    ttyWrites,
    adapterCalls,
    adapterNames,
    bootstrapCalls,
    runtimeCalls,
  };
}

describe("session-helper CLI", () => {
  test("host mode injects the host-ready prompt from --participant-link", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.1";

    const exitCode = await (module.main as any)(
      ["host", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "host", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["claude-code"]);
  });

  test("host mode auto-detects Codex when Codex session markers are present", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    harness.environment.env = {
      CODEX_THREAD_ID: "thread-123",
    };
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.1";

    const exitCode = await (module.main as any)(
      ["host", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "host", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["codex"]);
  });

  test("guest mode injects the guest-ready prompt from --participant-link", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.2";

    const exitCode = await (module.main as any)(
      ["guest", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "guest", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["claude-code"]);
  });

  test("guest mode auto-detects Codex when Codex session markers are present", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    harness.environment.env = {
      CODEX_MANAGED_BY_NPM: "1",
    };
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.2";

    const exitCode = await (module.main as any)(
      ["guest", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "guest", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["codex"]);
  });

  test("help output documents both host and guest bootstrap commands", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();

    const exitCode = await (module.main as any)(["--help"], harness.environment);

    expect(exitCode).toBe(0);
    expect(harness.stdout.join("")).toContain(
      "agentmeets-session host --participant-link <url>",
    );
    expect(harness.stdout.join("")).toContain(
      "agentmeets-session guest --participant-link <url>",
    );
  });

  test("bootstrap mode accepts pasted invite instructions and starts the resident runtime", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    const pastedText =
      "Tell your agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.2";

    const exitCode = await (module.main as any)(
      ["bootstrap", "--pasted-text", pastedText],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.bootstrapCalls).toEqual([
      {
        pastedText,
        adapterName: "claude-code",
      },
    ]);
    expect(harness.runtimeCalls).toHaveLength(1);
    expect(harness.runtimeCalls[0]).toMatchObject({
      rootDir: "/tmp/agentmeets-runtime-root",
      roomId: "ROOM-789",
      role: "guest",
      roomLabel: "Room r_9wK3mQvH8",
      initialStatus: "waiting_for_host",
      wsUrl: "ws://agentmeets.test/rooms/ROOM-789/ws?token=guest-session-token",
    });
  });
});
