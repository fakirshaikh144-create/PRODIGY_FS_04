import type { Server as HttpServer } from "http";
import mysql from "mysql2/promise";
import { WebSocketServer } from "ws";
import { pool } from "./db";
import { verifySocketToken } from "./auth";

type ClientState = {
  userId: number;
  username: string;
  socket: import("ws").WebSocket;
  subscriptions: Set<string>;
};

type AttachmentPayload = {
  name: string;
  url: string;
  type: string;
} | null;

function keyForRoom(roomId: number) {
  return `room:${roomId}`;
}

function keyForConversation(conversationId: number) {
  return `conversation:${conversationId}`;
}

function getOnlineUserIds(clients: Set<ClientState>) {
  return [...new Set([...clients].map((client) => client.userId))];
}

async function persistRoomMessage(
  senderId: number,
  roomId: number,
  content: string,
  attachment: AttachmentPayload
) {
  const [membership] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
    [roomId, senderId]
  );

  if (membership.length === 0) {
    throw new Error("Not a room member");
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `
      INSERT INTO messages (sender_id, room_id, content, attachment_name, attachment_url, attachment_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      senderId,
      roomId,
      content,
      attachment?.name ?? null,
      attachment?.url ?? null,
      attachment?.type ?? null,
    ]
  );

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `
      SELECT m.*, u.username AS sender_name
      FROM messages m
      INNER JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `,
    [result.insertId]
  );

  return rows[0];
}

async function persistDirectMessage(
  senderId: number,
  conversationId: number,
  content: string,
  attachment: AttachmentPayload
) {
  const [membership] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1",
    [conversationId, senderId]
  );

  if (membership.length === 0) {
    throw new Error("Not a conversation member");
  }

  const [result] = await pool.query<mysql.ResultSetHeader>(
    `
      INSERT INTO messages (sender_id, conversation_id, content, attachment_name, attachment_url, attachment_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      senderId,
      conversationId,
      content,
      attachment?.name ?? null,
      attachment?.url ?? null,
      attachment?.type ?? null,
    ]
  );

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `
      SELECT m.*, u.username AS sender_name
      FROM messages m
      INNER JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `,
    [result.insertId]
  );

  return rows[0];
}

export function attachWebSocketServer(server: HttpServer) {
  const wss = new WebSocketServer({ server });
  const clients = new Set<ClientState>();

  const broadcast = (channel: string, payload: unknown) => {
    const serialized = JSON.stringify(payload);

    for (const client of clients) {
      if (client.subscriptions.has(channel)) {
        client.socket.send(serialized);
      }
    }
  };

  const broadcastPresence = () => {
    const payload = JSON.stringify({
      type: "presence",
      onlineUserIds: getOnlineUserIds(clients),
    });

    for (const client of clients) {
      client.socket.send(payload);
    }
  };

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url || "", "http://localhost");
    const user = verifySocketToken(url.searchParams.get("token"));

    if (!user) {
      socket.close(4001, "Unauthorized");
      return;
    }

    const client: ClientState = {
      userId: user.userId,
      username: user.username,
      socket,
      subscriptions: new Set(),
    };
    clients.add(client);
    broadcastPresence();

    socket.send(
      JSON.stringify({
        type: "ready",
        userId: user.userId,
        onlineUserIds: getOnlineUserIds(clients),
      })
    );

    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(String(raw)) as any;

        if (message.type === "join-room" && typeof message.roomId === "number") {
          const [membership] = await pool.query<mysql.RowDataPacket[]>(
            "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1",
            [message.roomId, client.userId]
          );

          if (membership.length > 0) {
            client.subscriptions.add(keyForRoom(message.roomId));
          }
          return;
        }

        if (message.type === "join-conversation" && typeof message.conversationId === "number") {
          const [membership] = await pool.query<mysql.RowDataPacket[]>(
            "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1",
            [message.conversationId, client.userId]
          );

          if (membership.length > 0) {
            client.subscriptions.add(keyForConversation(message.conversationId));
          }
          return;
        }

        if (message.type === "send-room-message" && typeof message.roomId === "number") {
          const content = String(message.content || "").trim();
          const attachment = message.attachment && typeof message.attachment.url === "string"
            ? {
                name: String(message.attachment.name || "attachment"),
                url: String(message.attachment.url),
                type: String(message.attachment.type || "application/octet-stream"),
              }
            : null;

          if (!content && !attachment) {
            return;
          }

          const saved = await persistRoomMessage(client.userId, message.roomId, content, attachment);
          broadcast(keyForRoom(message.roomId), {
            type: "room-message",
            message: {
              id: saved.id,
              content: saved.content,
              createdAt: saved.created_at,
              senderId: saved.sender_id,
              senderName: saved.sender_name,
              roomId: saved.room_id,
              conversationId: null,
              attachmentName: saved.attachment_name,
              attachmentUrl: saved.attachment_url,
              attachmentType: saved.attachment_type,
            },
          });
          return;
        }

        if (message.type === "send-direct-message" && typeof message.conversationId === "number") {
          const content = String(message.content || "").trim();
          const attachment = message.attachment && typeof message.attachment.url === "string"
            ? {
                name: String(message.attachment.name || "attachment"),
                url: String(message.attachment.url),
                type: String(message.attachment.type || "application/octet-stream"),
              }
            : null;

          if (!content && !attachment) {
            return;
          }

          const saved = await persistDirectMessage(client.userId, message.conversationId, content, attachment);
          broadcast(keyForConversation(message.conversationId), {
            type: "direct-message",
            message: {
              id: saved.id,
              content: saved.content,
              createdAt: saved.created_at,
              senderId: saved.sender_id,
              senderName: saved.sender_name,
              roomId: null,
              conversationId: saved.conversation_id,
              attachmentName: saved.attachment_name,
              attachmentUrl: saved.attachment_url,
              attachmentType: saved.attachment_type,
            },
          });
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid WebSocket message" }));
      }
    });

    socket.on("close", () => {
      clients.delete(client);
      broadcastPresence();
    });
  });
}
