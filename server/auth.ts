import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { NextFunction, Response } from "express";
import { pool } from "./db";
import type { AuthenticatedRequest, JwtPayload } from "./types";

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function ensureGeneralRoomForUser(userId: number) {
  const [roomRows] = await pool.query<any[]>(
    "SELECT id FROM rooms WHERE name = ? LIMIT 1",
    ["General"]
  );

  if (roomRows.length === 0) {
    const [roomResult] = await pool.query<any>(
      "INSERT INTO rooms (name, created_by) VALUES (?, ?)",
      ["General", userId]
    );
    await pool.query("INSERT IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)", [
      roomResult.insertId,
      userId,
    ]);
    return;
  }

  await pool.query("INSERT IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)", [
    roomRows[0].id,
    userId,
  ]);
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET) as JwtPayload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function verifySocketToken(token: string | null) {
  if (!token) {
    return null;
  }

  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
