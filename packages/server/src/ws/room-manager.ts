import type {
  Sender,
  ServerMessage,
} from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import type { AgentMeetsStore } from "../db/store.js";

export interface WsData {
  roomId: string;
  role: Sender;
}

interface ActiveRoom {
  roomId: string;
  host: ServerWebSocket<WsData> | null;
  guest: ServerWebSocket<WsData> | null;
  isActive: boolean;
}

interface RelayMessageInput {
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

interface RoomManagerOptions {
  idleTimeoutMs?: number;
}

const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB

export class RoomManager {
  private readonly rooms = new Map<string, ActiveRoom>();
  private readonly roomTasks = new Map<string, Promise<void>>();
  private readonly store: AgentMeetsStore;

  constructor(store: AgentMeetsStore, _options: RoomManagerOptions = {}) {
    this.store = store;
  }

  async addConnection(
    roomId: string,
    role: Sender,
    ws: ServerWebSocket<WsData>,
  ): Promise<void> {
    const room = this.ensureRoom(roomId);
    room[role] = ws;

    await this.serializeRoom(roomId, async () => {
      await this.store.markRoleConnected(roomId, role);
      if (this.getConnection(roomId, role) !== ws) {
        return;
      }

      const roomState = await this.store.getRoom(roomId);
      if (!roomState) {
        this.cleanupRoom(roomId);
        return;
      }
      if (roomState.status === "closed" || roomState.status === "expired") {
        this.cleanupRoom(roomId);
        return;
      }

      if (role === "guest" && room[role] === ws) {
        await this.replayRoomHistory(roomId, role, ws);
      }

      await this.maybeActivateRoom(roomId);

      if (role === "host" && room[role] === ws) {
        await this.replayRoomHistory(roomId, role, ws);
      }
    });
  }

  removeConnection(roomId: string, role: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    room[role] = null;
    void this.serializeRoom(roomId, async () => {
      await this.store.clearRoleConnected(roomId, role);
    }).catch(logRoomManagerError);
  }

  shutdown(): void {
    for (const roomId of this.rooms.keys()) {
      this.cleanupRoom(roomId);
    }
  }

  getOtherParticipant(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    return role === "host" ? room.guest : room.host;
  }

  getConnection(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    return room[role];
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  cleanupRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  async handleMessage(
    roomId: string,
    senderRole: Sender,
    message: RelayMessageInput,
  ): Promise<boolean> {
    if (Buffer.byteLength(message.content, "utf8") > MAX_MESSAGE_SIZE) {
      return false;
    }

    await this.serializeRoom(roomId, async () => {
      const persisted = await this.store.saveMessage(roomId, senderRole, message.content);

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
    });

    return true;
  }

  async handleEnd(roomId: string, senderRole: Sender): Promise<void> {
    await this.serializeRoom(roomId, async () => {
      await this.store.closeRoom(roomId, "user_ended");

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
    });
  }

  async handleDisconnect(roomId: string, disconnectedRole: Sender): Promise<void> {
    await this.serializeRoom(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) {
        return;
      }

      room[disconnectedRole] = null;
      if (!room.host && !room.guest) {
        this.cleanupRoom(roomId);
      }
    });
  }

  async expireIdleRoomIfNeeded(_roomId: string): Promise<boolean> {
    return false;
  }

  private async maybeActivateRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.isActive || !room.host || !room.guest) {
      return;
    }

    room.isActive = true;

    try {
      await this.store.activateRoom(roomId);
    } catch (error) {
      room.isActive = false;
      throw error;
    }

    sendJson(room.host, { type: "room_active", roomId });
    sendJson(room.guest, { type: "room_active", roomId });
  }

  private async replayRoomHistory(
    roomId: string,
    role: Sender,
    recipient: ServerWebSocket<WsData>,
  ): Promise<void> {
    for (const message of await this.store.getReplayMessages(roomId, role)) {
      sendJson(recipient, {
        type: "message",
        messageId: message.id,
        sender: message.sender,
        clientMessageId: `persisted:${message.id}`,
        replyToMessageId: null,
        content: message.content,
        createdAt: message.created_at,
      });
    }
  }

  private ensureRoom(roomId: string): ActiveRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, host: null, guest: null, isActive: false };
      this.rooms.set(roomId, room);
    }

    return room;
  }

  private async serializeRoom<T>(
    roomId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.roomTasks.get(roomId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = previous.catch(() => undefined).then(() => gate);
    this.roomTasks.set(roomId, marker);

    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release?.();
      if (this.roomTasks.get(roomId) === marker) {
        this.roomTasks.delete(roomId);
      }
    }
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function logRoomManagerError(error: unknown): void {
  console.error("RoomManager error", error);
}
