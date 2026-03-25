export interface PublicRoomPayload {
  roomId: string;
  roomStem: string;
  status: "waiting_for_join" | "activating" | "active";
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string | null;
}

export type PublicRoomResponse =
  | ({
      kind: "room";
    } & PublicRoomPayload)
  | {
      kind: "expired";
    };

export async function readPublicRoomResponse(
  response: Response,
): Promise<PublicRoomResponse> {
  if (response.status === 410) {
    return { kind: "expired" };
  }

  if (!response.ok) {
    throw new Error(`Failed to load room: ${response.status}`);
  }

  const payload = (await response.json()) as PublicRoomPayload;
  return {
    kind: "room",
    ...payload,
  };
}
