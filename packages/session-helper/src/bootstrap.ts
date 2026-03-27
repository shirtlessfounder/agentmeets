import { detectInvite } from "./adapters/detect-invite.js";
import type { SessionBootstrapStatus, SessionSender } from "./protocol.js";

export type SessionAdapterName = "claude-code" | "codex";
export type BootstrapFailureCode =
  | "invalid_invite"
  | "invite_expired"
  | "runtime_failure";

export class BootstrapInviteError extends Error {
  readonly code: BootstrapFailureCode;

  constructor(code: BootstrapFailureCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export interface BootstrapInviteRuntimeResult {
  adapterName: SessionAdapterName;
  inviteToken: string;
  inviteUrl: string;
  roomId: string;
  roomLabel: string;
  role: SessionSender;
  status: SessionBootstrapStatus;
  openingMessage: string;
  expiresAt: string;
  sessionToken: string;
  wsUrl: string;
}

interface InviteManifest {
  roomId: string;
  roomStem: string;
  role: SessionSender;
  status: SessionBootstrapStatus;
  openingMessage: string;
  expiresAt: string;
}

interface InviteClaim {
  roomId: string;
  role: SessionSender;
  sessionToken: string;
  status: SessionBootstrapStatus;
}

export async function bootstrapInviteRuntime({
  pastedText,
  adapterName,
  fetchFn = fetch,
}: {
  pastedText: string;
  adapterName: SessionAdapterName;
  fetchFn?: typeof fetch;
}): Promise<BootstrapInviteRuntimeResult> {
  const invite = detectInvite(pastedText);
  if (!invite) {
    throw new BootstrapInviteError("invalid_invite");
  }

  const inviteUrl = new URL(invite.inviteUrl);
  const manifest = await fetchJson<InviteManifest>(
    fetchFn,
    invite.inviteUrl,
    undefined,
  );
  const claim = await fetchJson<InviteClaim>(
    fetchFn,
    `${inviteUrl.origin}/invites/${invite.inviteToken}/claim`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": `agentmeets-session-${manifest.role}-${invite.inviteToken}`,
      },
    },
  );

  return {
    adapterName,
    inviteToken: invite.inviteToken,
    inviteUrl: invite.inviteUrl,
    roomId: claim.roomId,
    roomLabel: `Room ${manifest.roomStem}`,
    role: claim.role,
    status: claim.status,
    openingMessage: manifest.openingMessage,
    expiresAt: manifest.expiresAt,
    sessionToken: claim.sessionToken,
    wsUrl: createWsUrl(inviteUrl.origin, claim.roomId, claim.sessionToken),
  };
}

async function fetchJson<T>(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw new BootstrapInviteError("runtime_failure", String(error));
  }

  if (!response.ok) {
    if (response.status === 410) {
      throw new BootstrapInviteError("invite_expired");
    }

    if (response.status === 404 || response.status === 409 || response.status === 400) {
      throw new BootstrapInviteError("invalid_invite");
    }

    throw new BootstrapInviteError("runtime_failure");
  }

  return (await response.json()) as T;
}

function createWsUrl(baseUrl: string, roomId: string, sessionToken: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/rooms/${roomId}/ws?token=${sessionToken}`;
}
