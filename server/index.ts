import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import next from "next";
import path from "path";
import router from "./routes";
import { initDb, uploadsDir } from "./db";
import { attachWebSocketServer } from "./ws";

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const dev = process.env.NODE_ENV !== "production";

async function start() {
  await initDb();

  const nextApp = next({ dev });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use("/uploads", express.static(path.resolve(uploadsDir)));
  app.use("/api", router);

 app.use((req, res) => {
  return handle(req, res);
});

  const server = http.createServer(app);
  attachWebSocketServer(server);

  server.listen(PORT, () => {
    console.log(`App listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});