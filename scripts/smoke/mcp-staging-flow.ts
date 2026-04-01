/**
 * End-to-end smoke test: MCP staging flow through a real server.
 *
 * Exercises the full user journey:
 *   create_meet → host_meet / guest_meet → send_and_wait → confirm_send → revise_draft → end_meet
 *
 * Covers:
 *   1. Room creation returns install instructions in sendToOtherPerson
 *   2. Host join + listen-only (confirm_send with no draftId)
 *   3. Guest join + first message via staging flow
 *   4. Full round-trip: stage → confirm → reply
 *   5. Draft revision flow (human interruption)
 *   6. Revert to original draft
 *   7. Manual immediate send ("send it" — no 5s wait)
 *   8. send_and_wait replaces existing staged draft
 *   9. End meet from both sides
 *  10. UI room page shows both links
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSmokeDatabaseUrl,
  startManagedProcess,
  waitForHttpReady,
} from "./lib/process";
import { createMeetController, type MeetController } from "../../packages/mcp-server/src/controller";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_PORT = 3200;
const UI_PORT = 3201;

/* ── helpers ── */

function parseToolResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function createAgent(serverUrl: string): MeetController {
  return createMeetController({ serverUrl, settleDelayMs: 200 });
}

/* ── scenarios ── */

async function main() {
  const databaseUrl = readSmokeDatabaseUrl();
  const serverBaseUrl = `http://127.0.0.1:${SERVER_PORT}`;
  const uiBaseUrl = `http://127.0.0.1:${UI_PORT}`;

  const serverProcess = startManagedProcess(
    "server",
    ["bun", "run", "src/index.ts"],
    join(ROOT, "packages/server"),
    {
      PORT: String(SERVER_PORT),
      DATABASE_URL: databaseUrl,
    },
  );

  try {
    await waitForHttpReady(`${serverBaseUrl}/health`, 10_000);

    const uiProcess = startManagedProcess(
      "ui",
      ["bun", "run", "dev", "--", "--port", String(UI_PORT)],
      join(ROOT, "packages/ui"),
      {
        AGENTMEETS_SERVER_URL: serverBaseUrl,
      },
    );

    try {
      await waitForHttpReady(`${uiBaseUrl}`, 20_000);
      await runScenarios({ serverBaseUrl, uiBaseUrl });
    } finally {
      await uiProcess.stop();
    }
  } finally {
    await serverProcess.stop();
  }
}

async function runScenarios({
  serverBaseUrl,
  uiBaseUrl,
}: {
  serverBaseUrl: string;
  uiBaseUrl: string;
}) {
  const scenarios: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "1. create_meet returns sendToOtherPerson with install instructions",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const result = parseToolResult(
          await host.createMeet({ openingMessage: "Install instructions test" }),
        );

        assert.equal(result.status, "waiting_for_both");
        assert.ok(typeof result.yourAgentLink === "string");
        assert.ok(typeof result.otherAgentLink === "string");

        // yourAgentInstruction is for the host's own agent
        const hostInstruction = result.yourAgentInstruction as string;
        assert.match(hostInstruction, /Join this chat now:/);
        assert.match(hostInstruction, /\.1$/);

        // sendToOtherPerson includes install instructions for the counterpart
        const sendToOther = result.sendToOtherPerson as string;
        assert.match(sendToOther, /npx innieslive@latest/);
        assert.match(sendToOther, /\.2$/);

        console.log("  PASS create_meet instructions");
      },
    },
    {
      name: "2. Host listen-only: confirm_send with no draftId waits for guest message",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        // Host creates room
        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Listen-only test opening" }),
        );
        const hostLink = room.yourAgentLink as string;
        const guestLink = room.otherAgentLink as string;

        // Both join
        const hostJoin = parseToolResult(await host.hostMeet({ participantLink: hostLink }));
        assert.equal(hostJoin.status, "connected");

        const guestJoin = parseToolResult(await guest.guestMeet({ participantLink: guestLink }));
        assert.equal(guestJoin.status, "connected");

        // Small settle delay for room_active propagation
        await Bun.sleep(300);

        // Host calls confirm_send with no draftId — listen-only
        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest stages and sends a message
        const guestStaged = parseToolResult(
          await guest.sendAndWait({ message: "Hello from guest!" }),
        );
        assert.equal(guestStaged.status, "staged");
        const guestDraftId = guestStaged.draftId as string;

        const guestSendResult = guest.confirmSend({ draftId: guestDraftId, timeout: 10 });

        // Host should receive guest's message
        const hostReceived = parseToolResult(await hostListenPromise);
        assert.equal(hostReceived.status, "ok");
        assert.equal(hostReceived.reply, "Hello from guest!");

        // Now host replies so guest's confirmSend can resolve
        const hostStaged = parseToolResult(
          await host.sendAndWait({ message: "Host heard you!" }),
        );
        const hostReply = await host.confirmSend({
          draftId: hostStaged.draftId as string,
          timeout: 10,
        });

        const guestReceived = parseToolResult(await guestSendResult);
        assert.equal(guestReceived.status, "ok");
        assert.equal(guestReceived.reply, "Host heard you!");

        await host.endMeet();
        await guest.endMeet();
        console.log("  PASS host listen-only mode");
      },
    },
    {
      name: "3. Full round-trip: stage → confirm → reply → stage → confirm",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Round-trip test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        // Host listens for guest's first message
        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest sends first message
        const g1 = parseToolResult(await guest.sendAndWait({ message: "Message 1 from guest" }));
        const guestWaitPromise = guest.confirmSend({ draftId: g1.draftId as string, timeout: 10 });

        // Host receives it
        const hostGot1 = parseToolResult(await hostListenPromise);
        assert.equal(hostGot1.reply, "Message 1 from guest");

        // Host replies
        const h1 = parseToolResult(await host.sendAndWait({ message: "Reply 1 from host" }));
        const hostWaitPromise = host.confirmSend({ draftId: h1.draftId as string, timeout: 10 });

        // Guest receives host's reply
        const guestGot1 = parseToolResult(await guestWaitPromise);
        assert.equal(guestGot1.reply, "Reply 1 from host");

        // Guest sends second message
        const g2 = parseToolResult(await guest.sendAndWait({ message: "Message 2 from guest" }));
        const guestWait2 = guest.confirmSend({ draftId: g2.draftId as string, timeout: 10 });

        // Host receives it
        const hostGot2 = parseToolResult(await hostWaitPromise);
        assert.equal(hostGot2.reply, "Message 2 from guest");

        // Host replies again
        const h2 = parseToolResult(await host.sendAndWait({ message: "Reply 2 from host" }));
        await host.confirmSend({ draftId: h2.draftId as string, timeout: 10 });

        const guestGot2 = parseToolResult(await guestWait2);
        assert.equal(guestGot2.reply, "Reply 2 from host");

        await host.endMeet();
        await guest.endMeet();
        console.log("  PASS full round-trip");
      },
    },
    {
      name: "4. Draft revision flow: stage → revise → confirm sends revised content",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Revision test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        // Host listens
        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest stages a draft
        const staged = parseToolResult(
          await guest.sendAndWait({ message: "Original draft" }),
        );
        assert.equal(staged.status, "staged");
        assert.equal(staged.message, "Original draft");
        assert.equal(staged.originalDraft, "Original draft");
        assert.equal(staged.holdSeconds, 5);
        const draftId = staged.draftId as string;

        // Human interrupts: "make it shorter"
        const revised = parseToolResult(
          await guest.reviseDraft({ draftId, revisedMessage: "Shorter draft" }),
        );
        assert.equal(revised.status, "staged");
        assert.equal(revised.message, "Shorter draft");
        assert.equal(revised.originalDraft, "Original draft"); // preserved
        assert.equal(revised.draftId, draftId); // same draftId

        // Human says "send it"
        const guestWaitPromise = guest.confirmSend({ draftId, timeout: 10 });

        // Host receives the REVISED content
        const hostGot = parseToolResult(await hostListenPromise);
        assert.equal(hostGot.reply, "Shorter draft");

        // Host replies to complete the cycle
        const h1 = parseToolResult(await host.sendAndWait({ message: "Got revised" }));
        await host.confirmSend({ draftId: h1.draftId as string, timeout: 10 });

        const guestGot = parseToolResult(await guestWaitPromise);
        assert.equal(guestGot.reply, "Got revised");

        await host.endMeet();
        await guest.endMeet();
        console.log("  PASS draft revision flow");
      },
    },
    {
      name: "5. Revert to original draft: stage → revise → revert → confirm sends original",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Revert test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest stages
        const staged = parseToolResult(
          await guest.sendAndWait({ message: "First version" }),
        );
        const draftId = staged.draftId as string;

        // Guest revises
        await guest.reviseDraft({ draftId, revisedMessage: "Bad edit" });

        // Human says "go back to the original"
        const reverted = parseToolResult(
          await guest.reviseDraft({ draftId, revisedMessage: staged.originalDraft as string }),
        );
        assert.equal(reverted.message, "First version");
        assert.equal(reverted.originalDraft, "First version");

        // Confirm sends the reverted (original) content
        const guestWaitPromise = guest.confirmSend({ draftId, timeout: 10 });

        const hostGot = parseToolResult(await hostListenPromise);
        assert.equal(hostGot.reply, "First version");

        // Complete cycle
        const h1 = parseToolResult(await host.sendAndWait({ message: "Ack" }));
        await host.confirmSend({ draftId: h1.draftId as string, timeout: 10 });
        await guestWaitPromise;

        await host.endMeet();
        await guest.endMeet();
        console.log("  PASS revert to original draft");
      },
    },
    {
      name: "6. send_and_wait replaces existing staged draft, old draftId becomes invalid",
      run: async () => {
        const host = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Replace draft test" }),
        );
        await host.hostMeet({ participantLink: room.yourAgentLink as string });

        // Stage first draft
        const first = parseToolResult(
          await host.sendAndWait({ message: "First" }),
        );
        const firstDraftId = first.draftId as string;

        // Stage second draft — replaces first
        const second = parseToolResult(
          await host.sendAndWait({ message: "Second" }),
        );
        assert.notEqual(second.draftId, firstDraftId);
        assert.equal(second.message, "Second");

        // Old draftId is now invalid
        const oldConfirm = await host.confirmSend({ draftId: firstDraftId, timeout: 5 });
        assert.equal(oldConfirm.isError, true);
        assert.match(
          (parseToolResult(oldConfirm).error as string),
          /draft id mismatch/i,
        );

        // Old draftId also invalid for revise
        const oldRevise = await host.reviseDraft({ draftId: firstDraftId, revisedMessage: "Nope" });
        assert.equal(oldRevise.isError, true);

        await host.endMeet();
        console.log("  PASS draft replacement invalidates old draftId");
      },
    },
    {
      name: "7. End meet from host side closes both sessions",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "End test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        // Guest is listening
        const guestListenPromise = guest.confirmSend({ timeout: 10 });

        // Host ends the meet
        const endResult = parseToolResult(await host.endMeet());
        assert.equal(endResult.status, "ended");

        // Guest should get notified
        const guestGot = parseToolResult(await guestListenPromise);
        assert.equal(guestGot.status, "ended");

        // Host can't send anymore
        const hostSend = await host.sendAndWait({ message: "Too late" });
        assert.equal(hostSend.isError, true);

        await guest.endMeet();
        console.log("  PASS end meet closes both sides");
      },
    },
    {
      name: "8. End meet from guest side closes both sessions",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Guest-end test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        // Host is listening
        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest ends the meet
        const endResult = parseToolResult(await guest.endMeet());
        assert.equal(endResult.status, "ended");

        // Host should get notified
        const hostGot = parseToolResult(await hostListenPromise);
        assert.equal(hostGot.status, "ended");

        await host.endMeet();
        console.log("  PASS guest-initiated end closes both sides");
      },
    },
    {
      name: "9. Multiple revisions before sending",
      run: async () => {
        const host = createAgent(serverBaseUrl);
        const guest = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Multi-revise test" }),
        );

        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await guest.guestMeet({ participantLink: room.otherAgentLink as string });
        await Bun.sleep(300);

        const hostListenPromise = host.confirmSend({ timeout: 10 });

        // Guest stages
        const staged = parseToolResult(
          await guest.sendAndWait({ message: "Version 1" }),
        );
        const draftId = staged.draftId as string;

        // Multiple revisions
        const r2 = parseToolResult(
          await guest.reviseDraft({ draftId, revisedMessage: "Version 2" }),
        );
        assert.equal(r2.message, "Version 2");
        assert.equal(r2.originalDraft, "Version 1");

        const r3 = parseToolResult(
          await guest.reviseDraft({ draftId, revisedMessage: "Version 3" }),
        );
        assert.equal(r3.message, "Version 3");
        assert.equal(r3.originalDraft, "Version 1"); // always the original

        const r4 = parseToolResult(
          await guest.reviseDraft({ draftId, revisedMessage: "Final version" }),
        );
        assert.equal(r4.message, "Final version");

        // Send the final version
        const guestWaitPromise = guest.confirmSend({ draftId, timeout: 10 });

        const hostGot = parseToolResult(await hostListenPromise);
        assert.equal(hostGot.reply, "Final version");

        // Complete cycle
        const h1 = parseToolResult(await host.sendAndWait({ message: "Got final" }));
        await host.confirmSend({ draftId: h1.draftId as string, timeout: 10 });
        await guestWaitPromise;

        await host.endMeet();
        await guest.endMeet();
        console.log("  PASS multiple revisions");
      },
    },
    {
      name: "10. UI room page shows both agent links",
      run: async () => {
        // Create room through the UI proxy
        const response = await fetch(`${uiBaseUrl}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ openingMessage: "UI smoke test" }),
        });
        assert.equal(response.status, 201);

        const room = (await response.json()) as {
          roomStem: string;
          hostAgentLink: string;
          guestAgentLink: string;
        };

        // Fetch the room page
        const pageResponse = await fetch(`${uiBaseUrl}/rooms/${room.roomStem}`);
        assert.equal(pageResponse.status, 200);

        const html = await pageResponse.text();

        // Both links should be in the page
        assert.ok(
          html.includes(room.hostAgentLink),
          `Room page missing host link: ${room.hostAgentLink}`,
        );
        assert.ok(
          html.includes(room.guestAgentLink),
          `Room page missing guest link: ${room.guestAgentLink}`,
        );

        console.log("  PASS UI room page shows links");
      },
    },
    {
      name: "11. Invite landing page shows install instructions",
      run: async () => {
        const response = await fetch(`${uiBaseUrl}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ openingMessage: "Landing page test" }),
        });
        const room = (await response.json()) as { guestAgentLink: string };

        // Extract invite token from the guest link
        const token = new URL(room.guestAgentLink).pathname.split("/").pop()!;

        // Try the invite manifest from the server
        const manifestResponse = await fetch(`${serverBaseUrl}/j/${token}`);
        assert.equal(manifestResponse.status, 200);

        const manifest = (await manifestResponse.json()) as {
          role: string;
          openingMessage: string;
        };
        assert.equal(manifest.role, "guest");
        assert.equal(manifest.openingMessage, "Landing page test");

        console.log("  PASS invite landing page");
      },
    },
    {
      name: "12. Error: operations after end_meet fail gracefully",
      run: async () => {
        const host = createAgent(serverBaseUrl);

        const room = parseToolResult(
          await host.createMeet({ openingMessage: "Post-end error test" }),
        );
        await host.hostMeet({ participantLink: room.yourAgentLink as string });
        await host.endMeet();

        // All operations should error
        const sendResult = await host.sendAndWait({ message: "Nope" });
        assert.equal(sendResult.isError, true);

        const confirmResult = await host.confirmSend({ timeout: 5 });
        assert.equal(confirmResult.isError, true);

        const reviseResult = await host.reviseDraft({ draftId: "fake", revisedMessage: "Nope" });
        assert.equal(reviseResult.isError, true);

        const endResult = await host.endMeet();
        assert.equal(endResult.isError, true);

        console.log("  PASS post-end errors");
      },
    },
  ];

  const completed: string[] = [];
  for (const scenario of scenarios) {
    console.log(`RUN  ${scenario.name}`);
    await scenario.run();
    completed.push(scenario.name);
  }

  console.log(`\n${completed.length}/${scenarios.length} MCP staging smoke scenarios passed.`);
}

await main();
