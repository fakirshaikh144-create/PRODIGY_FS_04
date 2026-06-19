import dotenv from "dotenv";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const {
  DB_HOST = "127.0.0.1",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_NAME = "prodigy_chat",
} = process.env;

export const uploadsDir = path.join(process.cwd(), "uploads");

export const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

async function ensureColumn(tableName: string, columnName: string, definition: string) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [DB_NAME, tableName, columnName]
  );

  if (rows.length === 0) {
    await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  }
}

export async function initDb() {
  await fs.mkdir(uploadsDir, { recursive: true });

  const bootstrapConnection = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
  });
  await bootstrapConnection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
  await bootstrapConnection.end();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INT NOT NULL,
      user_id INT NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_read_message_id INT NULL,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INT NOT NULL,
      user_id INT NOT NULL,
      last_read_message_id INT NULL,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender_id INT NOT NULL,
      room_id INT NULL,
      conversation_id INT NULL,
      content TEXT NOT NULL,
      attachment_name VARCHAR(255) NULL,
      attachment_url VARCHAR(255) NULL,
      attachment_type VARCHAR(120) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      CHECK (
        (room_id IS NOT NULL AND conversation_id IS NULL) OR
        (room_id IS NULL AND conversation_id IS NOT NULL)
      )
    )
  `);

  await ensureColumn("room_members", "last_read_message_id", "INT NULL");
  await ensureColumn("conversation_members", "last_read_message_id", "INT NULL");
  await ensureColumn("messages", "attachment_name", "VARCHAR(255) NULL");
  await ensureColumn("messages", "attachment_url", "VARCHAR(255) NULL");
  await ensureColumn("messages", "attachment_type", "VARCHAR(120) NULL");

  const [existingRooms] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT id FROM rooms WHERE name = ? LIMIT 1",
    ["General"]
  );

  if (existingRooms.length === 0) {
    const [systemUserRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM users ORDER BY id ASC LIMIT 1"
    );

    if (systemUserRows.length > 0) {
      const systemUserId = systemUserRows[0].id as number;
      const [roomResult] = await pool.query<mysql.ResultSetHeader>(
        "INSERT INTO rooms (name, created_by) VALUES (?, ?)",
        ["General", systemUserId]
      );
      await pool.query(
        "INSERT IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)",
        [roomResult.insertId, systemUserId]
      );
    }
  }
}
