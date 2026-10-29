import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 60 * 60 * 1000;
const PRESENCE_TTL_MS = 45 * 1000;
const MAX_MESSAGES = 500;
const MAX_CIPHERTEXT_LENGTH = 12_000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
// SQLite limits an individual BLOB/row to 2 MB. Keep each encrypted chunk well below that.
const MEDIA_CHUNK_BYTES = 1024 * 1024;
const MAX_MEDIA_FILES = 30;
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
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/messages|\/ws|\/media\/[^/]+(?:\/consume)?)?$/);

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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS media_once (id TEXT PRIMARY KEY)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS media_once_views (media_id TEXT NOT NULL, viewer_id TEXT NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY (media_id, viewer_id))`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS media_chunks (media_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (media_id, chunk_index))`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") return this.createRoom(request);

    const room = await this.getActiveRoom();
    if (!room) return json({ error: "Room not found or expired" }, 404);

    if (url.pathname.endsWith("/ws") && request.method === "GET") return this.connectWebSocket(request);
    if (request.method === "GET" && /^\/api\/rooms\/[^/]+$/.test(url.pathname)) return this.getMessages(room);
    const mediaMatch = url.pathname.match(/^\/api\/rooms\/[^/]+\/media\/([0-9a-f-]{36})$/i);
    if (mediaMatch) {
      const [, mediaId] = mediaMatch;
      if (request.method === "PUT") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_MEDIA_BYTES + 16) return json({ error: "Media must be 20 MB or smaller" }, 413);
        const data = new Uint8Array(await request.arrayBuffer());
        if (!data.byteLength || data.byteLength > MAX_MEDIA_BYTES + 16) return json({ error: "Media must be 20 MB or smaller" }, 413);
        const total = this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM media_files").toArray()[0].total;
        if (total >= MAX_MEDIA_FILES) return json({ error: "This room has reached its media limit" }, 429);
        let inserted = false;
        try {
          this.ctx.storage.sql.exec("INSERT INTO media_files (id, data, created_at) VALUES (?, ?, ?)", mediaId, new Uint8Array(), Date.now());
          inserted = true;
          for (let offset = 0, chunkIndex = 0; offset < data.byteLength; offset += MEDIA_CHUNK_BYTES, chunkIndex++) {
            this.ctx.storage.sql.exec("INSERT INTO media_chunks (media_id, chunk_index, data) VALUES (?, ?, ?)", mediaId, chunkIndex, data.slice(offset, offset + MEDIA_CHUNK_BYTES));
          }
        } catch {
          if (inserted) {
            this.ctx.storage.sql.exec("DELETE FROM media_chunks WHERE media_id = ?", mediaId);
            this.ctx.storage.sql.exec("DELETE FROM media_files WHERE id = ?", mediaId);
          }
          return json({ error: "Could not store this media" }, 409);
        }
        if (request.headers.get("x-media-view-once") === "true") {
          this.ctx.storage.sql.exec("INSERT INTO media_once (id) VALUES (?)", mediaId);
        }
        return json({ stored: true }, 201);
      }
      if (request.method === "GET") {
        const exists = this.ctx.storage.sql.exec("SELECT id FROM media_files WHERE id = ? AND id NOT IN (SELECT id FROM media_once)", mediaId).toArray()[0];
        if (!exists) return json({ error: "Media not found or room ended" }, 404);
        return this.mediaResponse(mediaId);
      }
      if (request.method === "DELETE") {
        this.ctx.storage.sql.exec("DELETE FROM media_files WHERE id = ?", mediaId);
        this.ctx.storage.sql.exec("DELETE FROM media_chunks WHERE media_id = ?", mediaId);
        this.ctx.storage.sql.exec("DELETE FROM media_once WHERE id = ?", mediaId);
        this.ctx.storage.sql.exec("DELETE FROM media_once_views WHERE media_id = ?", mediaId);
        return json({ deleted: true });
      }
    }
    const consumeMatch = url.pathname.match(/^\/api\/rooms\/[^/]+\/media\/([0-9a-f-]{36})\/consume$/i);
    if (consumeMatch && request.method === "POST") {
      const [, mediaId] = consumeMatch;
      const viewerId = request.headers.get("x-viewer-id") || "";
      if (!/^[0-9a-f-]{36}$/i.test(viewerId)) return json({ error: "Could not identify this chat participant" }, 400);
      const once = this.ctx.storage.sql.exec("SELECT id FROM media_once WHERE id = ?", mediaId).toArray()[0];
      if (!once) return json({ error: "This image is not available for view-once access" }, 404);
      const previousView = this.ctx.storage.sql.exec("SELECT 1 FROM media_once_views WHERE media_id = ? AND viewer_id = ?", mediaId, viewerId).toArray()[0];
      if (previousView) return json({ error: "You have already viewed this image" }, 410);
      const exists = this.ctx.storage.sql.exec("SELECT id FROM media_files WHERE id = ?", mediaId).toArray()[0];
      if (!exists) return json({ error: "This image is no longer available" }, 404);
      this.ctx.storage.sql.exec("INSERT INTO media_once_views (media_id, viewer_id, viewed_at) VALUES (?, ?, ?)", mediaId, viewerId, Date.now());
      return this.mediaResponse(mediaId);
    }
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

  mediaResponse(mediaId) {
    const legacy = this.ctx.storage.sql.exec("SELECT data FROM media_files WHERE id = ?", mediaId).toArray()[0];
    const chunks = this.ctx.storage.sql.exec("SELECT data FROM media_chunks WHERE media_id = ? ORDER BY chunk_index", mediaId).toArray();
    if (!legacy && !chunks.length) return json({ error: "Media not found or room ended" }, 404);
    if (!chunks.length) return new Response(legacy.data, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    const binaryChunks = chunks.map(({ data }) => new Uint8Array(data));
    const size = binaryChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of binaryChunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(combined, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
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
      } else if (frame.type === "heartbeat") {
        // Heartbeats carry no user data; they refresh the named connection lease.
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
      socket.serializeAttachment({ sender: frame.sender, name: frame.name.trim(), heartbeatEnabled: frame.heartbeat === true, lastSeen: Date.now() });
      this.broadcastPresence();
      await this.schedulePresenceAlarm(room.expiresAt);
      return;
    }
    if (frame.type === "heartbeat") {
      try {
        const participant = socket.deserializeAttachment();
        if (participant?.heartbeatEnabled && participant?.sender && participant?.name) {
          socket.serializeAttachment({ ...participant, lastSeen: Date.now() });
          await this.schedulePresenceAlarm(room.expiresAt);
        }
      } catch { /* this connection has not joined */ }
      return;
    }
    if (this.messageCount() >= MAX_MESSAGES) {
      socket.send(JSON.stringify({ type: "error", error: "Room message limit reached" }));
      return;
    }
    await this.storeAndBroadcast(frame.message);
  }

  async webSocketClose(socket, code, reason) {
    this.broadcastPresence(socket);
    const room = await this.getActiveRoom();
    if (room) await this.schedulePresenceAlarm(room.expiresAt);
  }

  async webSocketError(socket) {
    try { socket.close(1011, "Connection error"); } catch { /* already closed */ }
    this.broadcastPresence(socket);
    const room = await this.getActiveRoom();
    if (room) await this.schedulePresenceAlarm(room.expiresAt);
  }

  closeSockets(reason) {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, reason); } catch { /* already closed */ }
    }
  }

  broadcastPresence(excludeSocket) {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets().filter((socket) => {
      if (socket === excludeSocket) return false;
      try {
        const participant = socket.deserializeAttachment();
        if (!participant?.sender || !participant?.name) return false;
        return !participant.heartbeatEnabled || now - participant.lastSeen < PRESENCE_TTL_MS;
      } catch { return false; }
    });
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

  async schedulePresenceAlarm(expiresAt) {
    const now = Date.now();
    let nextAlarm = expiresAt;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const participant = socket.deserializeAttachment();
        if (participant?.heartbeatEnabled && Number.isFinite(participant.lastSeen)) {
          const staleAt = participant.lastSeen + PRESENCE_TTL_MS;
          if (staleAt > now) nextAlarm = Math.min(nextAlarm, staleAt);
        }
      } catch { /* unjoined or legacy connection */ }
    }
    await this.ctx.storage.setAlarm(nextAlarm);
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
    const room = await this.getActiveRoom();
    if (!room) {
      this.endRoom("expired");
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const participant = socket.deserializeAttachment();
        if (participant?.heartbeatEnabled && now - participant.lastSeen >= PRESENCE_TTL_MS) {
          socket.close(1000, "Presence timed out");
        }
      } catch { /* leave connections without a lease alone */ }
    }
    this.broadcastPresence();
    await this.schedulePresenceAlarm(room.expiresAt);
  }
}
