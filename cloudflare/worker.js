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

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/messages|\/ws)?$/);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const roomId = crypto.randomUUID();
      const room = env.ROOMS.getByName(roomId);
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 2048) return json({ error: "Invalid room owner key" }, 400);
      const createResponse = await room.fetch("https://room.internal/create", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      if (createResponse.status === 400) return createResponse;
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
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("cache-control", "no-cache");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") return this.createRoom(request);

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
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "Owner authorization required" }, 403); }
      const owner = this.ctx.storage.sql.exec("SELECT public_key FROM room_owner WHERE id = 1").toArray()[0];
      if (!owner || typeof payload?.signature !== "string" || payload.signature.length > 256) {
        return json({ error: "Only the room creator can discard this room" }, 403);
      }
      let authorized = false;
      try {
        const publicKey = await crypto.subtle.importKey("spki", base64ToBytes(owner.public_key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        authorized = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" }, publicKey, base64ToBytes(payload.signature),
          new TextEncoder().encode(`discard:${url.pathname.split("/")[3]}`),
        );
      } catch { /* malformed owner signature */ }
      if (!authorized) return json({ error: "Only the room creator can discard this room" }, 403);
      this.endRoom("discarded");
      await this.ctx.storage.deleteAll();
      return json({ deleted: true });
    }
    return json({ error: "Not found" }, 404);
  }

  async createRoom(request) {
    let payload;
    try { payload = await request.json(); } catch { return json({ error: "Invalid room owner key" }, 400); }
    if (typeof payload?.ownerPublicKey !== "string" || payload.ownerPublicKey.length > 512) {
      return json({ error: "Invalid room owner key" }, 400);
    }
    try {
      await crypto.subtle.importKey("spki", base64ToBytes(payload.ownerPublicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch { return json({ error: "Invalid room owner key" }, 400); }
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO room_owner (id, public_key) VALUES (1, ?)", payload.ownerPublicKey);
    const expiresAt = Date.now() + ROOM_TTL_MS;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO room_meta (id, expires_at) VALUES (1, ?)", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
    return json({ expiresAt });
  }

  async getActiveRoom() {
    const row = this.ctx.storage.sql.exec("SELECT expires_at FROM room_meta WHERE id = 1").toArray()[0];
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      this.endRoom("expired");
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
    let frame;
    try {
      if (typeof rawMessage !== "string" || rawMessage.length > MAX_CIPHERTEXT_LENGTH + 1024) throw new Error("Invalid frame");
      frame = JSON.parse(rawMessage);
      if (frame.type === "join") {
        if (typeof frame.sender !== "string" || frame.sender.length < 1 || frame.sender.length > 64 ||
            typeof frame.name !== "string" || !frame.name.trim() || frame.name.trim().length > 24) throw new Error("Invalid name");
      } else if (frame.type !== "message" || !validMessage(frame.message)) {
        throw new Error("Invalid message");
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid chat data" }));
      return;
    }

    const room = await this.getActiveRoom();
    if (!room) {
      socket.close(1008, "Room expired");
      return;
    }
    if (frame.type === "join") {
      socket.serializeAttachment({ sender: frame.sender, name: frame.name.trim() });
      this.broadcastPresence();
      return;
    }
    if (this.messageCount() >= MAX_MESSAGES) {
      socket.send(JSON.stringify({ type: "error", error: "Room message limit reached" }));
      return;
    }
    await this.storeAndBroadcast(frame.message);
  }

  webSocketClose(socket, code, reason) {
    this.broadcastPresence(socket);
  }

  webSocketError(socket) {
    try { socket.close(1011, "Connection error"); } catch { /* already closed */ }
    this.broadcastPresence(socket);
  }

  closeSockets(reason) {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, reason); } catch { /* already closed */ }
    }
  }

  broadcastPresence(excludeSocket) {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== excludeSocket);
    const participants = sockets.flatMap((socket) => {
      try {
        const participant = socket.deserializeAttachment();
        return participant?.sender && participant?.name
          ? [{ sender: participant.sender, name: participant.name }]
          : [];
      } catch { return []; }
    });
    const frame = JSON.stringify({ type: "presence", participants });
    for (const socket of sockets) {
      try { socket.send(frame); } catch { socket.close(1011, "Presence update failed"); }
    }
  }

  endRoom(reason) {
    const frame = JSON.stringify({ type: "ended", reason });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
        socket.close(1000, reason === "discarded" ? "Room discarded" : "Room expired");
      } catch { /* already closed */ }
    }
  }

  async alarm() {
    this.endRoom("expired");
    await this.ctx.storage.deleteAll();
  }
}
