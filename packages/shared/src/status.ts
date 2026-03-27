import type { RoomStatus, StoredRoomStatus } from "./types.js";

export interface RoomStatusSnapshot {
  roomStatus: StoredRoomStatus;
  hostConnectedAt: string | null;
  guestConnectedAt: string | null;
}

export function derivePublicRoomStatus(snapshot: RoomStatusSnapshot): RoomStatus {
  if (snapshot.roomStatus === "active") {
    return "active";
  }

  if (snapshot.roomStatus === "closed") {
    return "ended";
  }

  if (snapshot.roomStatus === "expired") {
    return "expired";
  }

  if (snapshot.hostConnectedAt && snapshot.guestConnectedAt) {
    return "active";
  }

  if (snapshot.hostConnectedAt) {
    return "waiting_for_guest";
  }

  if (snapshot.guestConnectedAt) {
    return "waiting_for_host";
  }

  return "waiting_for_both";
}
