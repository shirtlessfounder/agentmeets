import type {
  Sender,
  CloseReason,
  ServerMessage,
  StoredRoomStatus,
} from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { activateRoom, closeRoom, expireRoom, saveMessage } from "../db/index.js";
import { getMessages } from "../db/messages.js";

export interface WsData {
  roomId: string;
  role: Sender;
}

interface ActiveRoom {
  roomId: string;
  host: ServerWebSocket<WsData> | null;
  guest: ServerWebSocket<WsData> | null;
  isActive: boolean;
  timers: {
    expiry?: Timer;
    idle?: Timer;
  };
}

interface RelayMessageInput {
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

interface RoomManagerOptions {
  idleTimeoutMs?: number;
}

interface RoomLifecycleState {
  roomStatus: StoredRoomStatus;
  inviteExpiresAt: string | null;
  hasClaimedInvite: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB

export class RoomManager {
  private rooms = new Map<string, ActiveRoom>();
  private db: Database;
  private idleTimeoutMs: number;

  constructor(db: Database, options: RoomManagerOptions = {}) {
    this.db = db;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  addConnection(roomId: string, role: Sender, ws: ServerWebSocket<WsData>): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, host: null, guest: null, isActive: false, timers: {} };
      this.rooms.set(roomId, room);
    }

    room[role] = ws;

    if (!room.isActive) {
      const lifecycle = this.getRoomLifecycleState(roomId);
      if (lifecycle && this.usesWaitingInviteExpiry(lifecycle) && !room.timers.expiry) {
        this.startWaitingExpiryTimer(roomId, lifecycle);
      }
      if (lifecycle && this.usesPreActivationIdleTimeout(lifecycle)) {
        clearTimeout(room.timers.expiry);
        room.timers.expiry = undefined;
        this.resetIdleTimeout(roomId);
      }
    }

    this.maybeActivateRoom(roomId);
  }

  removeConnection(roomId: string, role: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room[role] = null;
  }

  getOtherParticipant(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return role === "host" ? room.guest : room.host;
  }

  getConnection(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room[role];
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  cleanupRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    clearTimeout(room.timers.expiry);
    clearTimeout(room.timers.idle);
    this.rooms.delete(roomId);
  }

  handleMessage(roomId: string, senderRole: Sender, message: RelayMessageInput): boolean {
    const room = this.rooms.get(roomId);
    if (Buffer.byteLength(message.content, "utf8") > MAX_MESSAGE_SIZE) {
      return false;
    }

    const persisted = saveMessage(this.db, roomId, senderRole, message.content);
    const sender = this.getConnection(roomId, senderRole);
    if (sender) {
      sendJson(sender, {
        type: "ack",
        messageId: persisted.id,
        clientMessageId: message.clientMessageId,
        replyToMessageId: message.replyToMessageId,
        createdAt: persisted.created_at,
      });
    }

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, {
        type: "message",
        messageId: persisted.id,
        sender: senderRole,
        clientMessageId: message.clientMessageId,
        replyToMessageId: message.replyToMessageId,
        content: message.content,
        createdAt: persisted.created_at,
      });
    }

    const lifecycle = this.getRoomLifecycleState(roomId);
    if (room?.isActive || (lifecycle && this.usesPreActivationIdleTimeout(lifecycle))) {
      this.resetIdleTimeout(roomId);
    }
    return true;
  }

  handleEnd(roomId: string, senderRole: Sender): void {
    closeRoom(this.db, roomId, "user_ended");

    const other = this.getOtherParticipant(roomId, senderRole);
    const sender = this.getConnection(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "ended", reason: "user_ended" });
    }
    if (sender) {
      sendJson(sender, { type: "ended", reason: "user_ended" });
    }
    this.cleanupRoom(roomId);

    if (other) {
      other.close(1000, "Room closed");
    }
    if (sender) {
      sender.close(1000, "Room closed");
    }
  }

  handleDisconnect(roomId: string, disconnectedRole: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (!room.isActive) {
      const hasConnections = room.host || room.guest;
      if (!hasConnections) {
        this.cleanupRoom(roomId);
      }
      return;
    }

    closeRoom(this.db, roomId, "disconnected");

    const otherRole: Sender = disconnectedRole === "host" ? "guest" : "host";
    const other = room[otherRole];
    if (other) {
      sendJson(other, { type: "ended", reason: "disconnected" });
    }

    this.cleanupRoom(roomId);

    if (other) {
      other.close(1000, "disconnected");
    }
  }

  // --- Timeout management ---

  private startWaitingExpiryTimer(roomId: string, lifecycle?: RoomLifecycleState): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const expiresAt = this.getInviteExpiry(lifecycle ?? this.getRoomLifecycleState(roomId));
    if (!expiresAt) {
      return;
    }

    room.timers.expiry = setTimeout(() => {
      const currentLifecycle = this.getRoomLifecycleState(roomId);
      if (!currentLifecycle) {
        this.cleanupRoom(roomId);
        return;
      }

      if (!this.usesWaitingInviteExpiry(currentLifecycle)) {
        const currentRoom = this.rooms.get(roomId);
        if (!currentRoom) {
          return;
        }

        clearTimeout(currentRoom.timers.expiry);
        currentRoom.timers.expiry = undefined;
        if (!currentRoom.isActive && this.usesPreActivationIdleTimeout(currentLifecycle)) {
          this.resetIdleTimeout(roomId);
        }
        return;
      }

      this.expireRoom(roomId);
    }, Math.max(0, expiresAt.getTime() - Date.now()));
  }

  private maybeActivateRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.isActive || !room.host || !room.guest) return;

    const lifecycle = this.getRoomLifecycleState(roomId);
    const inviteExpiry = this.getInviteExpiry(lifecycle);
    if (
      lifecycle
      && this.usesWaitingInviteExpiry(lifecycle)
      && inviteExpiry
      && inviteExpiry.getTime() <= Date.now()
    ) {
      clearTimeout(room.timers.expiry);
      room.timers.expiry = undefined;
      this.expireRoom(roomId);
      return;
    }

    room.isActive = true;
    clearTimeout(room.timers.expiry);
    room.timers.expiry = undefined;
    activateRoom(this.db, roomId);

    sendJson(room.host, { type: "room_active" });
    sendJson(room.guest, { type: "room_active" });
    this.replayPendingMessages(roomId, "host", room.guest);
    this.replayPendingMessages(roomId, "guest", room.host);

    this.resetIdleTimeout(roomId);
  }

  private resetIdleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearTimeout(room.timers.idle);
    room.timers.idle = setTimeout(() => {
      this.expireRoom(roomId);
    }, this.idleTimeoutMs);
  }

  private replayPendingMessages(
    roomId: string,
    sender: Sender,
    recipient: ServerWebSocket<WsData>,
  ): void {
    const pendingMessages = getMessages(this.db, roomId).filter(
      (message) => message.sender === sender,
    );
    for (const message of pendingMessages) {
      sendJson(recipient, {
        type: "message",
        messageId: message.id,
        sender,
        clientMessageId: `persisted:${message.id}`,
        replyToMessageId: null,
        content: message.content,
        createdAt: message.created_at,
      });
    }
  }

  private getRoomLifecycleState(roomId: string): RoomLifecycleState | null {
    const row = this.db
      .prepare(
        `SELECT
           r.status AS room_status,
           MIN(i.expires_at) AS invite_expires_at,
           MAX(CASE WHEN i.claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS has_claimed_invite
         FROM rooms r
         LEFT JOIN invites i ON i.room_id = r.id
         WHERE r.id = ?
         GROUP BY r.id, r.status`,
      )
      .get(roomId) as
      | {
          room_status: StoredRoomStatus;
          invite_expires_at: string | null;
          has_claimed_invite: number;
        }
      | null;

    if (!row) {
      return null;
    }

    return {
      roomStatus: row.room_status,
      inviteExpiresAt: row.invite_expires_at,
      hasClaimedInvite: row.has_claimed_invite > 0,
    };
  }

  private getInviteExpiry(lifecycle: RoomLifecycleState | null): Date | null {
    if (!lifecycle?.inviteExpiresAt) {
      return null;
    }

    return new Date(lifecycle.inviteExpiresAt);
  }

  private usesWaitingInviteExpiry(lifecycle: RoomLifecycleState): boolean {
    return lifecycle.roomStatus === "waiting" && !lifecycle.hasClaimedInvite;
  }

  private usesPreActivationIdleTimeout(lifecycle: RoomLifecycleState): boolean {
    return lifecycle.roomStatus === "active" || lifecycle.hasClaimedInvite;
  }

  private expireRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    expireRoom(this.db, roomId);

    const msg: ServerMessage = { type: "ended", reason: "expired" };
    const host = room.host;
    const guest = room.guest;

    this.cleanupRoom(roomId);

    if (host) {
      sendJson(host, msg);
      host.close(1000, "Room expired");
    }
    if (guest) {
      sendJson(guest, msg);
      guest.close(1000, "Room expired");
    }
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}
