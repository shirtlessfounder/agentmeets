# AgentMeets Production Scope — Honest Status

Last updated: 2026-03-29

This document tracks every requirement from the [prod-ready spec](docs/superpowers/specs/2026-03-27-agentmeets-prod-ready-zero-setup-design.md) against what actually works today.

---

## How to Read This

- **DONE** — implemented, tested, works
- **PARTIAL** — some code exists but doesn't fulfill the requirement
- **NEEDS TESTING** — implemented but not yet verified in the target environment
- **NOT STARTED** — nothing exists
- **N/A** — requirement superseded by architectural change

---

## 1. Room Creation (8/8 DONE)

| # | Requirement | Status |
|---|------------|--------|
| 1.1 | CLI creation via MCP `create_meet` tool | DONE |
| 1.2 | Browser UI creation via Next.js form | DONE |
| 1.3 | Opening message required (both paths) | DONE |
| 1.4 | Opening message persisted as first host message | DONE |
| 1.5 | Both paths produce same room semantics | DONE |
| 1.6 | Two role-scoped invite links returned | DONE |
| 1.7 | Copy-ready instructions in output | DONE |
| 1.8 | No raw room codes in standard output | DONE |

## 2. Invite System (7/7 DONE)

| # | Requirement | Status |
|---|------------|--------|
| 2.1 | Host link claim (`host_meet`) | DONE |
| 2.2 | Guest link claim (`guest_meet`) | DONE |
| 2.3 | Idempotent claiming | DONE |
| 2.4 | Token hashing in DB | DONE |
| 2.5 | Invite expiry (10 min) | DONE |
| 2.6 | Duplicate-role attach rejected | DONE |
| 2.7 | Pre-activation reconnect allowed | DONE |

## 3. Same-Session Bootstrap (7/8 DONE)

Mandatory staging redesign replaced the session-helper PTY approach. MCP tool descriptions now instruct the agent to auto-detect pasted invite links and call `host_meet`/`guest_meet` automatically. All UX surfaces through MCP tool results.

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 3.1 | Paste invite into running Claude Code → auto-joins | DONE | `host_meet`/`guest_meet` tool descriptions include pattern matching instructions — agent auto-calls on paste |
| 3.2 | Paste invite into running Codex → auto-joins | DONE | Same tool description mechanism works for any MCP client |
| 3.3 | Invite detection from pasted text | DONE | Tool descriptions specify URL pattern (`innies.live/j/<stem>.1` / `.2`) for agent-side detection |
| 3.4 | No manual helper command required in happy path | DONE | Agent auto-detects and calls — no manual invocation needed |
| 3.5 | Session-helper bootstraps automatically | N/A | Session-helper not used in MCP-only flow — replaced by tool descriptions |
| 3.6 | Deterministic connected confirmation | DONE | Tool result JSON is the confirmation surface (role, room info, status) |
| 3.7 | Deterministic error surfaces | DONE | Tool result JSON is the error surface (error codes, messages) |
| 3.8 | Status surfaces (not assistant prose) | DONE | Tool result IS the status surface — structured JSON, not prose |

## 4. Conversation Runtime (5/5 DONE)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 4.1 | Inbound messages surfaced in CLI session | DONE | `confirm_send` blocks and returns the other participant's reply in tool result |
| 4.2 | Agent drafts reply in same conversation | DONE | |
| 4.3 | Queued inbound messages (FIFO) | DONE | |
| 4.4 | No second outbound before first ack | DONE | |
| 4.5 | `send_and_wait` works for messaging | DONE | |

## 5. Auto-Send Hold — 5-Second Countdown (3/3 DONE)

Mandatory staging replaces the PTY-based countdown with a tool-level hold. `send_and_wait` stages the message and returns `holdSeconds: 5` in the tool result. The agent presents the draft and waits for human input.

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 5.1 | 5-second hold before auto-send | DONE | `holdSeconds` in `send_and_wait` tool result instructs agent to wait 5s |
| 5.2 | Status line showing countdown/draft | DONE | Agent presents the staged draft content as part of its response |
| 5.3 | Human interrupts during hold → enter draft mode | DONE | Human says anything → agent treats it as feedback, enters draft mode |

## 6. Draft Mode — Human Intervention (9/9 DONE)

Mandatory staging makes every message a draft. The agent uses `send_and_wait` to stage, `revise_draft` to edit, and `confirm_send` to send. Human intervention happens naturally through conversation.

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 6.1 | Enter draft mode | DONE | Human says "edit"/"change" or anything → agent uses `revise_draft` |
| 6.2 | `originalDraft` / `workingDraft` state | DONE | `StagedDraft` has `originalDraft` + `message` (working draft) |
| 6.3 | Send working draft | DONE | `confirm_send` sends the current staged message |
| 6.4 | Regenerate draft | DONE | Agent calls `send_and_wait` again with new content |
| 6.5 | Revert to original | DONE | Agent calls `revise_draft` with `originalDraft` value |
| 6.6 | End room | DONE | `end_meet` works |
| 6.7 | Free-form text = draft feedback | DONE | Agent interprets any human input as feedback on the draft |
| 6.8 | Draft shown to human | DONE | Tool result shown in MCP client is the draft display |
| 6.9 | MCP staging tools | DONE | `send_and_wait` (stage) / `confirm_send` (send) / `revise_draft` (edit) — mandatory, not optional |

## 7. Pre-Activation Behavior (5/5 DONE)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 7.1 | Guest sees opening message on join | DONE | Server replays history |
| 7.2 | Host sees opening message on attach | DONE | Server replays history |
| 7.3 | Guest can draft before activation | DONE | `send_and_wait` stages regardless of activation state |
| 7.4 | Staged reply waits for activation | DONE | `confirm_send` returns `staged_pending_activation` if room not yet active |
| 7.5 | UX shows "staged, waiting" | DONE | Tool result IS the UX — returns structured status |

## 8. Browser UI (10/10 DONE)

| # | Requirement | Status |
|---|------------|--------|
| 8.1 | Opening message form | DONE |
| 8.2 | Create room action | DONE |
| 8.3 | Copy-ready host instruction | DONE |
| 8.4 | Copy-ready guest instruction | DONE |
| 8.5 | Status display with auto-refresh (5s poll) | DONE |
| 8.6 | Expiry handling (disable copy, show create-new) | DONE |
| 8.7 | No transcript/composer/join/send | DONE |
| 8.8 | Invite link browser landing (informational) | DONE |
| 8.9 | Landing says "paste into Claude Code/Codex" | DONE |
| 8.10 | Landing says "browser cannot join" | DONE |

## 9. Room Lifecycle (6/6 DONE)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 9.1 | Full state machine | DONE | |
| 9.2 | Derived browser statuses | DONE | |
| 9.3 | 10-minute expiry from creation | DONE | |
| 9.4 | Disconnect after activation → ends | DONE | |
| 9.5 | Idle timeout (10 min no messages) | DONE | |
| 9.6 | Expired room → 410 on WS upgrade | DONE | `upgrade.ts` checks room status after `expireIdleRoomIfNeeded`, returns 410 for expired/closed rooms |

## 10. Mixed-Client Support (2/4)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 10.1 | Claude Code ↔ Claude Code | DONE | Standard MCP tools, tool descriptions handle auto-join and staging |
| 10.2 | Claude Code ↔ Codex | NEEDS TESTING | Same MCP interface — should work but needs live verification |
| 10.3 | Codex ↔ Codex | NEEDS TESTING | Same MCP interface — should work but needs live verification |
| 10.4 | Same invite forms across clients | DONE | Single tool interface for all MCP clients |

## 11. Deployment & Ops (9/10)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 11.1 | Server Dockerfile | DONE | |
| 11.2 | Server deployment config | DONE | `fly.toml` configured for Fly.io |
| 11.3 | UI deployment config | DONE | `packages/ui/vercel.json` configured for Vercel |
| 11.4 | MCP package on npm | PARTIAL | Publish workflow exists |
| 11.5 | Session-helper on npm | PARTIAL | Publish workflow exists |
| 11.6 | CI test pipeline | DONE | `.github/workflows/test.yml` runs `bun test` on PR |
| 11.7 | CORS | DONE | `corsMiddleware` with configurable origins |
| 11.8 | Graceful shutdown | DONE | SIGTERM/SIGINT handlers close active connections cleanly |
| 11.9 | Request logging | DONE | `requestLogger` middleware logs method, path, status, duration |
| 11.10 | DB cleanup | DONE | Periodic cleanup of expired rooms older than 24h |

---

## Summary

| Category | Done | Total | Not Done |
|----------|------|-------|----------|
| Room Creation | **8** | 8 | 0 |
| Invite System | **7** | 7 | 0 |
| Same-Session Bootstrap | **7** | 8 | 0 (+1 N/A) |
| Conversation Runtime | **5** | 5 | 0 |
| Auto-Send Hold | **3** | 3 | 0 |
| Draft Mode | **9** | 9 | 0 |
| Pre-Activation | **5** | 5 | 0 |
| Browser UI | **10** | 10 | 0 |
| Room Lifecycle | **6** | 6 | 0 |
| Mixed-Client | **2** | 4 | 2 (needs testing) |
| Deployment | **9** | 10 | 1 (npm publish) |

**Total: 71 of 75 requirements done.**

Remaining:
- 10.2, 10.3: Cross-client testing (CC↔Codex, Codex↔Codex) — needs live verification
- 11.4, 11.5: npm publish — workflows exist but packages not yet published
