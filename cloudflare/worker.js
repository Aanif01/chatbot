import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_MESSAGES = 500;
const MAX_CIPHERTEXT_LENGTH = 12_000;
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function validMessage(value) {
  return value && typeof value.ciphertext === "string" && value.ciphertext.length > 0 &&
    value.ciphertext.length <= MAX_CIPHERTEXT_LENGTH && typeof value.nonce === "string" &&
    value.nonce.length <= 64 && typeof value.sender === "string" &&
    value.sender.length > 0 && value.sender.length <= 64;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/messages|\/ws)?$/);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const roomId = crypto.randomUUID();
      const room = env.ROOMS.getByName(roomId);
      const createResponse = await room.fetch("https://room.internal/create", { method: "POST" });
      if (!createResponse.ok) return json({ error: "Could not create room" }, 500);
      return json({ id: roomId, ...(await createResponse.json()) }, 201);
    }

    if (match) {
      const [, roomId] = match;
      if (!ROOM_ID_PATTERN.test(roomId)) return json({ error: "Room not found or expired" }, 404);
      const room = env.ROOMS.getByName(roomId);
      return room.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        expires_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sender TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") return this.createRoom();

    const room = await this.getActiveRoom();
    if (!room) return json({ error: "Room not found or expired" }, 404);

    if (url.pathname.endsWith("/ws") && request.method === "GET") return this.connectWebSocket(request);
    if (request.method === "GET" && /^\/api\/rooms\/[^/]+$/.test(url.pathname)) return this.getMessages(room);
    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      let payload;
      const announcedLength = Number(request.headers.get("content-length") ?? 0);
      if (announcedLength > 16 * 1024) return json({ error: "Request is too large" }, 413);
      try {
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > 16 * 1024) return json({ error: "Request is too large" }, 413);
        payload = JSON.parse(body);
      }
      catch { return json({ error: "Invalid JSON" }, 400); }
      if (!validMessage(payload)) return json({ error: "Invalid encrypted message" }, 400);
      if (this.messageCount() >= MAX_MESSAGES) return json({ error: "Room message limit reached" }, 429);
      return json(await this.storeAndBroadcast(payload), 201);
    }
    if (request.method === "DELETE" && /^\/api\/rooms\/[^/]+$/.test(url.pathname)) {
      this.closeSockets("Room discarded");
      await this.ctx.storage.deleteAll();
      return json({ deleted: true });
    }
    return json({ error: "Not found" }, 404);
  }

  async createRoom() {
    const expiresAt = Date.now() + ROOM_TTL_MS;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO room_meta (id, expires_at) VALUES (1, ?)", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
    return json({ expiresAt });
  }

  async getActiveRoom() {
    const row = this.ctx.storage.sql.exec("SELECT expires_at FROM room_meta WHERE id = 1").toArray()[0];
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      this.closeSockets("Room expired");
      await this.ctx.storage.deleteAll();
      return undefined;
    }
    return { expiresAt: row.expires_at };
  }

  getMessages(room) {
    const messages = this.ctx.storage.sql.exec(
      "SELECT id, ciphertext, nonce, sender, sent_at AS sentAt FROM messages ORDER BY sent_at, rowid",
    ).toArray();
    return json({ messages, expiresAt: room.expiresAt });
  }

  messageCount() {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM messages").toArray()[0].total;
  }

  async storeAndBroadcast(payload) {
    const message = {
      id: crypto.randomUUID(),
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
      sender: payload.sender,
      sentAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, ciphertext, nonce, sender, sent_at) VALUES (?, ?, ?, ?, ?)",
      message.id, message.ciphertext, message.nonce, message.sender, message.sentAt,
    );
    const frame = JSON.stringify({ type: "message", message });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(frame); } catch { socket.close(1011, "Delivery failed"); }
    }
    return message;
  }

  connectWebSocket(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "ready" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    let payload;
    try {
      if (typeof rawMessage !== "string" || rawMessage.length > MAX_CIPHERTEXT_LENGTH + 1024) throw new Error("Invalid frame");
      const frame = JSON.parse(rawMessage);
      if (frame.type !== "message" || !validMessage(frame.message)) throw new Error("Invalid message");
      payload = frame.message;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid encrypted message" }));
      return;
    }

    const room = await this.getActiveRoom();
    if (!room) {
      socket.close(1008, "Room expired");
      return;
    }
    if (this.messageCount() >= MAX_MESSAGES) {
      socket.send(JSON.stringify({ type: "error", error: "Room message limit reached" }));
      return;
    }
    await this.storeAndBroadcast(payload);
  }

  webSocketClose(socket, code, reason) {
    socket.close(code, reason);
  }

  webSocketError(socket) {
    socket.close(1011, "Connection error");
  }

  closeSockets(reason) {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, reason); } catch { /* already closed */ }
    }
  }

  async alarm() {
    this.closeSockets("Room expired");
    await this.ctx.storage.deleteAll();
  }
}
