import { closeSync, openSync, writeSync } from "node:fs";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";

export type SessionAdapterName = "claude-code" | "codex";

interface CreateSessionAdapterOptions {
  adapterName: SessionAdapterName;
  writeToPty: (chunk: string) => void | Promise<void>;
}

const HELP_TEXT = `agentmeets-session

Usage:
  agentmeets-session host --room-id <roomId> --host-token <token> --invite-link <url> [--adapter claude-code|codex]
  agentmeets-session --help

Description:
  Runtime helpers for AgentMeets same-session coordination.
  Persists session state under .context/agentmeets/<roomId>/state.json
  and supports countdown-driven manual draft fallback.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (argv[0] === "host") {
    return runHost(argv.slice(1));
  }

  process.stderr.write(`Unknown arguments: ${argv.join(" ")}\n\n${HELP_TEXT}`);
  return 1;
}

async function runHost(argv: string[]): Promise<number> {
  const options = parseFlags(argv);
  const roomId = options["room-id"];
  const hostToken = options["host-token"];
  const inviteLink = options["invite-link"];
  const adapterName = (options.adapter ?? "claude-code") as string;

  if (!roomId || !hostToken || !inviteLink) {
    process.stderr.write(
      "Missing required host arguments: --room-id, --host-token, --invite-link\n",
    );
    return 1;
  }

  if (!isSessionAdapterName(adapterName)) {
    process.stderr.write(`Unsupported adapter: ${adapterName}\n`);
    return 1;
  }

  let ttyFd: number;
  try {
    ttyFd = openSync("/dev/tty", "w");
  } catch (error) {
    process.stderr.write(
      `Cannot open controlling PTY at /dev/tty: ${formatError(error)}\n`,
    );
    return 1;
  }

  try {
    const adapter = createSessionAdapter({
      adapterName,
      writeToPty(chunk) {
        writeSync(ttyFd, chunk);
      },
    });

    if ("injectHostReadyPrompt" in adapter) {
      await adapter.injectHostReadyPrompt({
        roomId,
        inviteLink,
      });
    }
    return 0;
  } finally {
    closeSync(ttyFd);
  }
}

export function createSessionAdapter({
  adapterName,
  writeToPty,
}: CreateSessionAdapterOptions): ClaudeCodeAdapter | CodexAdapter {
  if (adapterName === "codex") {
    return new CodexAdapter({ writeToPty });
  }

  return new ClaudeCodeAdapter({ writeToPty });
}

function parseFlags(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      continue;
    }

    options[token.slice(2)] = value;
    index += 1;
  }

  return options;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isSessionAdapterName(value: string): value is SessionAdapterName {
  return value === "claude-code" || value === "codex";
}

const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  const exitCode = await main();
  process.exit(exitCode);
}
