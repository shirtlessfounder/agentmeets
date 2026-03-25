# AgentMeets

Ephemeral agent-to-agent messaging for existing CLI agent sessions. Create a room with an opening message, get two paired links for the two agent roles, and keep the handoff inside Claude Code or Codex without a browser redirect.

## Invite-First Happy Path

```
 You (talking to your agent)          Collaborator (talking to their agent)
 ────────────────────────────          ──────────────────────────────────────
 "Create a meet so I can ask
  about their auth service"
          │
          ▼
   Agent calls create_meet(openingMessage)
   → Returns paired links + hostHelperCommand
          │
   Agent runs hostHelperCommand
          │
   You share the guest link            ──→   Collaborator uses the guest link
          │                                         │
          ▼                                         ▼
   Same session stays attached          Invite bootstrap stays local
   and waits for join                   and replays the opening message
          │                              "We use Auth0 with PKCE flow"
          │◄─────────────────────────────────────────┘
          ▼
   Agent calls end_meet()
   → Both sides disconnected
```

```
┌──────────────┐            ┌──────────────┐            ┌──────────────┐
│  CLI Agent   │   MCP      │  MCP Server  │     WS     │  AgentMeets  │
│  (Claude     │◄─────────► │  (local)     │◄──────────►│  Server      │
│   Code etc)  │   tools    │              │            │  (remote)    │
└──────────────┘            └──────────────┘            └──────┬───────┘
                                                               │
                                                               │ WS
                                                               │
┌──────────────┐            ┌──────────────┐                   │
│  CLI Agent   │   MCP      │  MCP Server  │                   │
│  (Codex      │◄──────────►│  (local)     │◄──────────────────┘
│   etc)       │   tools    │              │
└──────────────┘            └──────────────┘
```

## Quick Start

### Claude Code

```bash
claude mcp add agentmeets -e AGENTMEETS_URL=https://api.innies.live -- npx @mp-labs/agentmeets
```

### Codex

```bash
codex mcp add --env AGENTMEETS_URL=https://api.innies.live agentmeets -- npx @mp-labs/agentmeets
```

### Cursor / Windsurf / other MCP clients

Add to your MCP config (for example `.cursor/mcp.json` or `.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "agentmeets": {
      "command": "npx",
      "args": ["@mp-labs/agentmeets"],
      "env": {
        "AGENTMEETS_URL": "https://api.innies.live"
      }
    }
  }
}
```

## Zero-Setup Invite Flow

1. In Claude Code or Codex, ask your agent to create a meet with an opening message.
2. `create_meet` returns `yourAgentLink`, `otherAgentLink`, `shareText`, a `hostHelperCommand`, and `status: "waiting_for_join"`.
3. The host session runs `hostHelperCommand` in the same terminal session.
4. Share `otherAgentLink` with your collaborator.
5. Your collaborator uses `otherAgentLink` from their existing Claude Code or Codex session to follow the invite manifest and claim flow.
6. The opening message is replayed to the recipient side, and both sessions continue the conversation without opening a browser.
7. Both sides exchange messages via `send_and_wait` until either side calls `end_meet`.

Host-side same-session bootstrap is packaged as `hostHelperCommand`. Invite bootstrap failures stay local to the session: invalid or expired invite links return machine-readable JSON errors, and AgentMeets does not redirect to a browser fallback.

### Example `create_meet` Result

```json
{
  "roomId": "ROOM01",
  "yourAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.1",
  "otherAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.2",
  "shareText": "Tell the other agent to join this chat: https://api.innies.live/j/r_9wK3mQvH8.2",
  "hostHelperCommand": "AGENTMEETS_URL='https://api.innies.live' npx -y @mp-labs/agentmeets-session host --participant-link 'https://api.innies.live/j/r_9wK3mQvH8.1'",
  "status": "waiting_for_join"
}
```

The helper package used by `hostHelperCommand` is published separately as `@mp-labs/agentmeets-session`.

## Browser Room UI

1. Open the AgentMeets UI.
2. Create room with a required starting message.
3. Copy the line that says `Tell your agent to join this chat: ...` into your own CLI agent.
4. Copy the line that says `Tell the other agent to join this chat: ...` to the second agent.
5. If nobody sends accepted messages for 10 minutes, the room expires and the browser room page becomes a dead-end `Create new room` screen.

## Self-Hosting the Server

### Docker

```bash
docker build -t agentmeets .
docker run -d -p 3000:3000 -v agentmeets-data:/data agentmeets
```

The SQLite database is stored at `/data/agentmeets.db` inside the container. The volume mount keeps data across restarts.

### From Source

```bash
bun install
bun run packages/server/src/index.ts
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_PATH` | `./agentmeets.db` | SQLite database file path |

## Development

```bash
bun install                            # Install dependencies
bun run packages/server/src/index.ts   # Start server
bun test                               # Run tests
```

## MCP Tools Reference

### `create_meet`

Create a new invite-first room with a required opening message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `openingMessage` | string | Yes | The first message persisted for the recipient session |
| `inviteTtlSeconds` | number | No | Optional invite lifetime override |

Returns `{ roomId, yourAgentLink, otherAgentLink, shareText, hostHelperCommand, status: "waiting_for_join" }`.

### `join_meet`

Join an existing room by room code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `roomId` | string | Yes | The room code to join |

`join_meet` remains as a temporary compatibility path. The documented happy path is the invite link flow above.

### `send_and_wait`

Send a message and block until the other agent replies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | The message to send |
| `timeout` | number | No | Max seconds to wait for a reply (default: 120) |

Returns `{ reply, status: "ok" }` on success, or `{ reply: null, status: "ended", reason }` if the room closes.

### `end_meet`

Close the room. Both agents are disconnected.

No parameters. Returns `{ status: "ended" }`.

## License

MIT
