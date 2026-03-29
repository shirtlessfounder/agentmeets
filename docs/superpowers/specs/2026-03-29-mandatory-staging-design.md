# AgentMeets Mandatory Staging Design

## Summary

Replace the fire-and-forget `send_and_wait` with a mandatory two-step staging flow that works on any MCP client (Claude Code, Codex, or any future client). The human stays in the loop by default — every outbound message is staged, shown to the human, and auto-sends after ~5 seconds unless the human interrupts.

This design eliminates the dependency on `/dev/tty`, the session-helper PTY approach, and any client-specific features (Channels, Elicitation). Everything works through standard MCP tool call/result cycles.

## Problem

The original spec calls for:
- 5-second auto-send countdown with "press e to edit"
- Helper-rendered terminal UI for draft mode
- Session-helper process writing to `/dev/tty`

`/dev/tty` returns `ENXIO` in Claude Code's Bash sandbox. The session-helper cannot render anything. The entire PTY-based approach is dead. Additionally, any client-specific mechanism (Claude Code Channels, Elicitation) won't work on Codex, violating the mixed-client requirement.

## Solution

The MCP tool interface IS the UI. The agent IS the intermediary. Standard MCP tool results replace terminal-rendered surfaces.

### Default Conversation Flow (Autopilot)

1. Inbound message arrives via `confirm_send` return value
2. Agent reads the reply, drafts a response automatically
3. Agent calls `send_and_wait(message)` — this **stages** the draft, does NOT send
4. Tool result shows the draft to the human: "Auto-sends in 5s. Say anything to edit."
5. Human does nothing → agent calls `confirm_send(draftId)` after ~5 seconds (agent-behavioral, not server-enforced — the `holdSeconds` field in the tool result instructs the agent to wait)
6. Message sends, blocks until reply arrives
7. Reply arrives → tool returns it → repeat from step 2

### Human Interrupt Flow (Draft Mode)

At step 5, if the human says anything ("e", "change the tone", "don't mention pricing"):
1. Agent does NOT call `confirm_send`
2. Agent revises the draft based on feedback
3. Agent calls `revise_draft(draftId, revisedMessage)` — updates the staged draft
4. Shows revised draft to human
5. Human says "send it" → agent calls `confirm_send`
6. Human gives more feedback → repeat from step 2

### Pre-Activation Flow

If guest joins before host (or vice versa):
1. Agent stages a draft via `send_and_wait`
2. Agent calls `confirm_send` → tool detects room not active
3. Returns `{ status: "staged_pending_activation", message: "Staged. Will send when other side connects." }`
4. When room becomes active, the next `confirm_send` call delivers the message

## MCP Tool Interface

### Tools

| Tool | Purpose | Sends? |
|------|---------|--------|
| `create_meet` | Create room, get invite links | N/A |
| `host_meet` | Claim host link (.1), connect WebSocket | N/A |
| `guest_meet` | Claim guest link (.2), connect WebSocket | N/A |
| `send_and_wait` | **Stage a draft for review** (does NOT send) | NO |
| `confirm_send` | Send the staged draft, wait for reply | YES |
| `revise_draft` | Update staged draft content | NO |
| `end_meet` | Close room | N/A |

### Removed Tools

- `join_meet` — legacy room-code join. Removed from standard flow.
- `stage_reply`, `send_staged`, `revise_staged` — replaced by the new `send_and_wait`/`confirm_send`/`revise_draft` consolidation.

### Tool Responses

**`send_and_wait(message, timeout?)` response:**
```json
{
  "status": "staged",
  "draftId": "uuid",
  "message": "the draft text",
  "originalDraft": "the draft text",
  "holdSeconds": 5,
  "instruction": "Reply will auto-send in 5s. Tell your agent to edit it, or say 'send it' to send now."
}
```

**`confirm_send(draftId, timeout?)` response (reply received):**
```json
{
  "status": "ok",
  "reply": "their response message",
  "queuedMessages": []
}
```

**`confirm_send(draftId, timeout?)` response (room not active):**
```json
{
  "status": "staged_pending_activation",
  "message": "Your reply is staged. It will send when the other side connects."
}
```

**`revise_draft(draftId, revisedMessage)` response:**
```json
{
  "status": "staged",
  "draftId": "uuid",
  "message": "updated draft text",
  "originalDraft": "original draft text"
}
```

## Same-Session Bootstrap

Pasting an invite link triggers auto-join through tool descriptions alone.

**Mechanism:** `host_meet` and `guest_meet` tool descriptions include:
- The URL pattern to match: `innies.live/j/<stem>.1` (host) and `innies.live/j/<stem>.2` (guest)
- Instruction: "If the user pastes a message containing this URL pattern, call this tool automatically with the URL as participantLink."

**Supported paste forms:**
- `Tell your agent to join this chat: https://innies.live/j/r_xxx.1`
- `Tell the other agent to join this chat: https://innies.live/j/r_xxx.2`
- Raw URL by itself
- URL embedded in natural language

**After join, tool result provides deterministic confirmation:**
```json
{
  "roomId": "ROOM01",
  "status": "connected",
  "role": "host",
  "roomLabel": "Room r_xxx",
  "pending": []
}
```

Agent presents: "Connected to Room r_xxx as host."

No separate session-helper process. No `/dev/tty`. No manual helper commands.

## Draft Mode Semantics

The spec's slash commands map to natural language:

| Spec Command | User Says | Agent Does |
|-------------|-----------|------------|
| `/send` | "send it" / "looks good" / "go" | Calls `confirm_send` |
| `/regenerate` | "try again" / "rewrite it" | Drafts new message, calls `revise_draft` |
| `/revert` | "go back to the original" | Calls `revise_draft` with `originalDraft` from staged result |
| `/end` | "end the meeting" | Calls `end_meet` |
| free-form | "make it shorter" / "don't mention X" | Revises based on feedback, calls `revise_draft` |

No slash command parsing. No `routeDraftCommand`. The agent understands natural language.

## Inbound Message Handling

No push mechanism needed. The blocking `confirm_send` call IS the listener.

1. Agent calls `confirm_send` → blocks waiting for reply
2. Reply arrives → tool returns it
3. Agent shows reply to human, drafts response, stages it
4. Repeat

If multiple messages arrive while the agent is drafting, the server queues them. `confirm_send` returns the first reply plus `queuedMessages` for any additional inbound messages.

## What This Replaces

The session-helper package (`@mp-labs/agentmeets-session`) is no longer in the critical path. Its modules (countdown, draft-controller, local-ui, adapters) remain published for standalone CLI use but are not required for the MCP flow.

Specifically eliminated from the MCP flow:
- `/dev/tty` writes
- Raw mode stdin for keypress capture
- PTY-based countdown display
- Helper-rendered terminal surfaces
- Session-helper as a subprocess

## Changes Required

### MCP Server (`packages/mcp-server`)

1. **`send_and_wait`** — change from send-immediately to stage-only. Return staged result with `draftId`, `originalDraft`, `holdSeconds`, `instruction`.
2. **`confirm_send`** — new tool. Takes `draftId` and `timeout`. Reads staged draft, sends it, waits for reply. If room not active, returns `staged_pending_activation`.
3. **`revise_draft`** — rename from `revise_staged`. Takes `draftId` and `revisedMessage`. Updates staged draft, returns new staged status with `originalDraft` preserved.
4. **Remove** `stage_reply`, `send_staged`, `revise_staged` (just added, now consolidated).
5. **Remove** `join_meet` from standard tool registration. Keep the controller method for legacy/diagnostic use.
6. **Update tool descriptions** for `host_meet`/`guest_meet` to include `innies.live` URL pattern matching and auto-join instructions.
7. **Update tool descriptions** for `send_and_wait` to instruct the agent on the staging flow and 5-second hold behavior.
8. **Add `originalDraft`** to `StagedDraft` interface in `client.ts`.

### Server (`packages/server`)

9. **Fix 410 bug** — `upgrade.ts` returns 500 instead of 410 for expired rooms. Need to check expiry before attempting `server.upgrade()`.
10. **Add CORS middleware** — allow requests from UI origin.
11. **Add graceful shutdown** — SIGTERM/SIGINT handler that calls `roomManager.shutdown()`.
12. **Add request logging** — middleware that logs method, path, status, duration.
13. **Add DB cleanup** — sweep expired rooms older than 24 hours on startup and periodically.
14. **Add opening message size limit** — cap `POST /rooms` body to prevent abuse.

### Browser UI (`packages/ui`)

15. **Verify invite landing page copy** — confirm it says "paste into Claude Code or Codex" and "browser cannot join."
16. **Fix if needed** — update landing page text if it doesn't match spec.

### Deployment

17. **Deploy server** — pick a platform (Fly.io, Railway, etc.), add config.
18. **Deploy UI** — Vercel or similar, configure `AGENTMEETS_SERVER_URL`.
19. **CI test workflow** — GitHub Action that runs `bun test` on PR/push.

### Testing

20. **Update MCP server tests** — update controller tests for new staging flow.
21. **Mixed-client smoke tests** — test all four pairings (CC↔CC, CC↔Codex, Codex↔Codex, Codex↔CC).
22. **Update SCOPE.md** — mark requirements as done as they're completed.

## Validation

This is done when all 75 requirements in SCOPE.md are marked DONE. No exceptions, no "partial," no "works in isolation."

## Parallelization

These workstreams are independent and can be dispatched to separate agents:

- **Agent A: MCP Server Tools** — items 1-8 (tool changes, descriptions, staging flow)
- **Agent B: Server Hardening** — items 9-14 (410 fix, CORS, shutdown, logging, cleanup, size limit)
- **Agent C: UI + Deployment** — items 15-19 (landing page, deploy server, deploy UI, CI)
- **Agent D: Testing** — items 20-22 (after A and B complete)
