import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import path from "path";
import router from "./routes";
import { initDb, uploadsDir } from "./db";
import { attachWebSocketServer } from "./ws";

dotenv.config();

const PORT = Number(process.env.PORT || 4000);

async function start() {
  await initDb();

  const app = express();
  // app.use(
  //   cors({
  //     origin: ["http://localhost:3000"],
  //     credentials: false,
  //   })
  // );
  app.use(cors({
  origin: true,
  credentials: true
}));
  app.use(express.json());
  app.use("/uploads", express.static(path.resolve(uploadsDir)));
  app.use("/api", router);

  const server = http.createServer(app);
  attachWebSocketServer(server);

  server.listen(PORT, () => {
    console.log(`API and WebSocket server listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
