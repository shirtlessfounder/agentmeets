import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ManagedProcess {
  name: string;
  stop(): Promise<void>;
}

export function readSmokeDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.AGENTMEETS_TEST_DATABASE_URL?.trim() ?? env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "AGENTMEETS_TEST_DATABASE_URL or DATABASE_URL is required for Postgres-backed smoke runs",
    );
  }
  return value;
}

export async function waitForHttpReady(
  url: string,
  timeoutMs = 10_000,
  isReady: (response: Response) => boolean = (response) => response.ok,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (isReady(response)) {
        return;
      }
    } catch {
      // Keep polling until the timeout expires.
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export async function createSmokeDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export function startManagedProcess(
  name: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): ManagedProcess {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "ignore",
  });

  return {
    name,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    },
  };
}
