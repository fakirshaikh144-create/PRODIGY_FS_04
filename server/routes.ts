import { Router } from "express";
import type mysql from "mysql2/promise";
import multer from "multer";
import path from "path";
import { comparePassword, ensureGeneralRoomForUser, hashPassword, requireAuth, signToken } from "./auth";
import { pool, uploadsDir } from "./db";
import type { AuthenticatedRequest } from "./types";

const router = Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (_req, file, callback) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      callback(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

function sanitizeMessage(row: any) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    senderId: row.sender_id,
    senderName: row.sender_name,
    roomId: row.room_id,
    conversationId: row.conversation_id,
    attachmentName: row.attachment_name,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type,
  };
}

router.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

router.post("/auth/register", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password || password.length < 4) {
    res.status(400).json({ error: "Username and password are required. Password must be at least 4 characters." });
    return;
  }

  const trimmedUsername = username.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  try {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [trimmedUsername, passwordHash]
    );

    await ensureGeneralRoomForUser(result.insertId);

    const token = signToken({ userId: result.insertId, username: trimmedUsername });
    res.status(201).json({
      token,
      user: { id: result.insertId, username: trimmedUsername },
    });
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "Username already exists" });
      return;
    }

    res.status(500).json({ error: "Failed to register user" });
  }
});

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const [rows] = await pool.query<any[]>("SELECT * FROM users WHERE username = ? LIMIT 1", [
    username.trim().toLowerCase(),
  ]);

  if (rows.length === 0) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const user = rows[0];
  const passwordMatches = await comparePassword(password, user.password_hash);

  if (!passwordMatches) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  await ensureGeneralRoomForUser(user.id);

  const token = signToken({ userId: user.id, username: user.username });
  res.json({
    token,
    user: { id: user.id, username: user.username },
  });
});

router.get("/bootstrap", requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;

  const [rooms] = await pool.query<any[]>(
    `
      SELECT
        r.id,
        r.name,
        COUNT(
          CASE
            WHEN m.id > COALESCE(rm.last_read_message_id, 0) AND m.sender_id != ?
            THEN 1
          END
        ) AS unread_count
      FROM rooms r
      INNER JOIN room_members rm ON rm.room_id = r.id
      LEFT JOIN messages m ON m.room_id = r.id
      WHERE rm.user_id = ?
      GROUP BY r.id, r.name
      ORDER BY r.name ASC
    `,
    [userId, userId]
  );

  const [users] = await pool.query<any[]>(
    "SELECT id, username FROM users WHERE id != ? ORDER BY username ASC",
    [userId]
  );

  const [availableRooms] = await pool.query<any[]>(
    `
      SELECT r.id, r.name
      FROM rooms r
      WHERE r.id NOT IN (
        SELECT room_id FROM room_members WHERE user_id = ?
      )
      ORDER BY r.name ASC
    `,
    [userId]
  );

  const [conversations] = await pool.query<any[]>(
    `
      SELECT
        c.id,
        u.id AS peer_id,
        u.username AS peer_username,
        MAX(c.created_at) AS created_at,
        COUNT(
          CASE
            WHEN m.id > COALESCE(me.last_read_message_id, 0) AND m.sender_id != ?
            THEN 1
          END
        ) AS unread_count
      FROM conversations c
      INNER JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
      INNER JOIN conversation_members them ON them.conversation_id = c.id AND them.user_id != ?
      INNER JOIN users u ON u.id = them.user_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id, u.id, u.username
      ORDER BY c.created_at DESC
    `,
    [userId, userId, userId]
  );

  res.json({
    user: req.user,
    rooms,
    availableRooms,
    users,
    conversations: conversations.map((row) => ({
      id: row.id,
      peerId: row.peer_id,
      peerUsername: row.peer_username,
      unreadCount: row.unread_count,
    })),
    onlineUserIds: [],
    roomsUnread: rooms.reduce((acc, room) => ({ ...acc, [room.id]: room.unread_count }), {}),
  });
});

router.post("/rooms", requireAuth, async (req: AuthenticatedRequest, res) => {
  const { name } = req.body as { name?: string };

  if (!name?.trim()) {
    res.status(400).json({ error: "Room name is required" });
    return;
  }

  try {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      "INSERT INTO rooms (name, created_by) VALUES (?, ?)",
      [name.trim(), req.user!.userId]
    );

    await pool.query("INSERT IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)", [
      result.insertId,
      req.user!.userId,
    ]);

    res.status(201).json({ id: result.insertId, name: name.trim(), unread_count: 0 });
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "Room already exists" });
      return;
    }

    res.status(500).json({ error: "Failed to create room" });
  }
});

router.post("/rooms/:roomId/join", requireAuth, async (req: AuthenticatedRequest, res) => {
  const roomId = Number(req.params.roomId);

  if (!Number.isInteger(roomId)) {
    res.status(400).json({ error: "Invalid room" });
    return;
  }

  await pool.query("INSERT IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)", [
    roomId,
    req.user!.userId,
  ]);

  const [rows] = await pool.query<any[]>("SELECT id, name FROM rooms WHERE id = ? LIMIT 1", [roomId]);
  res.json({ ok: true, room: rows[0] ?? null });
});

router.post("/uploads", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "File is required" });
    return;
  }

  res.status(201).json({
    name: req.file.originalname,
    type: req.file.mimetype,
    url: `/uploads/${path.basename(req.file.filename)}`,
  });
});

router.post("/conversations/direct", requireAuth, async (req: AuthenticatedRequest, res) => {
  const { targetUserId } = req.body as { targetUserId?: number };
  const userId = req.user!.userId;

  if (!targetUserId || targetUserId === userId) {
    res.status(400).json({ error: "A valid target user is required" });
    return;
  }

  const [existingRows] = await pool.query<any[]>(
    `
      SELECT c.id
      FROM conversations c
      INNER JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
      INNER JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
      GROUP BY c.id
      HAVING COUNT(*) = 1
    `,
    [userId, targetUserId]
  );

  if (existingRows.length > 0) {
    res.json({ id: existingRows[0].id });
    return;
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [conversationResult] = await connection.query<mysql.ResultSetHeader>(
      "INSERT INTO conversations () VALUES ()"
    );

    await connection.query(
      "INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)",
      [conversationResult.insertId, userId, conversationResult.insertId, targetUserId]
    );

    await connection.commit();
    res.status(201).json({ id: conversationResult.insertId });
  } catch {
    await connection.rollback();
    res.status(500).json({ error: "Failed to create conversation" });
  } finally {
    connection.release();
  }
});

router.get("/messages/room/:roomId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const roomId = Number(req.params.roomId);

  const [messages] = await pool.query<any[]>(
    `
      SELECT m.*, u.username AS sender_name
      FROM messages m
      INNER JOIN users u ON u.id = m.sender_id
      INNER JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
      WHERE m.room_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `,
    [req.user!.userId, roomId]
  );

  res.json(messages.map(sanitizeMessage));
});

router.get("/messages/conversation/:conversationId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const conversationId = Number(req.params.conversationId);

  const [messages] = await pool.query<any[]>(
    `
      SELECT m.*, u.username AS sender_name
      FROM messages m
      INNER JOIN users u ON u.id = m.sender_id
      INNER JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `,
    [req.user!.userId, conversationId]
  );

  res.json(messages.map(sanitizeMessage));
});

router.post("/messages/room/:roomId/read", requireAuth, async (req: AuthenticatedRequest, res) => {
  const roomId = Number(req.params.roomId);
  await pool.query(
    `
      UPDATE room_members rm
      LEFT JOIN (
        SELECT MAX(id) AS last_message_id
        FROM messages
        WHERE room_id = ?
      ) latest ON 1 = 1
      SET rm.last_read_message_id = latest.last_message_id
      WHERE rm.room_id = ? AND rm.user_id = ?
    `,
    [roomId, roomId, req.user!.userId]
  );

  res.json({ ok: true });
});

router.post("/messages/conversation/:conversationId/read", requireAuth, async (req: AuthenticatedRequest, res) => {
  const conversationId = Number(req.params.conversationId);
  await pool.query(
    `
      UPDATE conversation_members cm
      LEFT JOIN (
        SELECT MAX(id) AS last_message_id
        FROM messages
        WHERE conversation_id = ?
      ) latest ON 1 = 1
      SET cm.last_read_message_id = latest.last_message_id
      WHERE cm.conversation_id = ? AND cm.user_id = ?
    `,
    [conversationId, conversationId, req.user!.userId]
  );

  res.json({ ok: true });
});

export default router;
