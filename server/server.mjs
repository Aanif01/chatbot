import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, webcrypto } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRoot = join(root, "web");
const port = Number(process.env.PORT ?? 3000);
const roomTtlMs = 60 * 60 * 1000;
const maxMessages = 500;
const maxBodyBytes = 16 * 1024;
const maxMediaBytes = 20 * 1024 * 1024 + 16;
const rooms = new Map();

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("body-too-large");
  }
  return JSON.parse(body);
}

async function readBytes(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("media-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function roomFor(id) {
  const room = rooms.get(id);
  if (!room || room.expiresAt <= Date.now()) {
    rooms.delete(id);
    return undefined;
  }
  return room;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const payload = await readJson(req);
      if (typeof payload?.ownerPublicKey !== "string" || payload.ownerPublicKey.length > 512) {
        return json(res, 400, { error: "Invalid room owner key" });
      }
      try {
        await webcrypto.subtle.importKey("spki", Buffer.from(payload.ownerPublicKey, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch { return json(res, 400, { error: "Invalid room owner key" }); }
      const id = randomUUID();
      const room = { expiresAt: Date.now() + roomTtlMs, messages: [], ownerPublicKey: payload.ownerPublicKey, media: new Map(), mediaOnce: new Set(), mediaViews: new Map() };
      rooms.set(id, room);
      return json(res, 201, { id, expiresAt: room.expiresAt });
    }

    if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
      const id = parts[2];
      const room = roomFor(id);
      if (!room) return json(res, 404, { error: "Room not found or expired" });
      if (parts[3] === "media" && parts[4] && /^[0-9a-f-]{36}$/i.test(parts[4])) {
        const mediaId = parts[4];
        if (parts.length === 5 && req.method === "PUT") {
          if (Number(req.headers["content-length"] ?? 0) > maxMediaBytes) return json(res, 413, { error: "Media must be 20 MB or smaller" });
          if (!room.media.has(mediaId) && room.media.size >= 30) return json(res, 429, { error: "This room has reached its media limit" });
          const bytes = await readBytes(req, maxMediaBytes);
          if (!bytes.length) return json(res, 400, { error: "Media is empty" });
          room.media.set(mediaId, bytes);
          if (req.headers["x-media-view-once"] === "true") room.mediaOnce.add(mediaId);
          return json(res, 201, { stored: true });
        }
        if (parts.length === 5 && req.method === "GET") {
          const bytes = room.media.get(mediaId);
          if (!bytes || room.mediaOnce.has(mediaId)) return json(res, 404, { error: "Media not found or room ended" });
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(bytes);
        }
        if (parts.length === 5 && req.method === "DELETE") {
          room.media.delete(mediaId); room.mediaOnce.delete(mediaId); room.mediaViews.delete(mediaId);
          return json(res, 200, { deleted: true });
        }
        if (parts.length === 6 && parts[5] === "consume" && req.method === "POST") {
          const viewerId = req.headers["x-viewer-id"] ?? "";
          if (!/^[0-9a-f-]{36}$/i.test(viewerId)) return json(res, 400, { error: "Could not identify this chat participant" });
          const bytes = room.media.get(mediaId);
          if (!room.mediaOnce.has(mediaId) || !bytes) return json(res, 404, { error: "This image is no longer available" });
          let viewers = room.mediaViews.get(mediaId);
          if (!viewers) room.mediaViews.set(mediaId, viewers = new Set());
          if (viewers.has(viewerId)) return json(res, 410, { error: "You have already viewed this image" });
          viewers.add(viewerId);
          res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return res.end(bytes);
        }
      }
      if (req.method === "GET" && parts.length === 3) return json(res, 200, { messages: room.messages, expiresAt: room.expiresAt });
      if (req.method === "POST" && parts[3] === "messages") {
        const message = await readJson(req);
        if (typeof message.ciphertext !== "string" || typeof message.nonce !== "string" || typeof message.sender !== "string") {
          return json(res, 400, { error: "Invalid encrypted message" });
        }
        if (message.ciphertext.length > 12000 || message.nonce.length > 64 || message.sender.length > 64) {
          return json(res, 413, { error: "Message is too large" });
        }
        if (room.messages.length >= maxMessages) return json(res, 429, { error: "Room message limit reached" });
        const stored = { id: randomUUID(), ciphertext: message.ciphertext, nonce: message.nonce, sender: message.sender, sentAt: Date.now() };
        room.messages.push(stored);
        return json(res, 201, stored);
      }
      if (req.method === "DELETE" && parts.length === 3) {
        let payload;
        try { payload = await readJson(req); } catch { return json(res, 403, { error: "Owner authorization required" }); }
        let authorized = false;
        try {
          const publicKey = await webcrypto.subtle.importKey("spki", Buffer.from(room.ownerPublicKey, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
          authorized = typeof payload?.signature === "string" && await webcrypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(payload.signature, "base64"),
            new TextEncoder().encode(`discard:${id}`),
          );
        } catch { /* malformed owner signature */ }
        if (!authorized) return json(res, 403, { error: "Only the room creator can discard this room" });
        rooms.delete(id);
        return json(res, 200, { deleted: true });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 404, { error: "Not found" });
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(webRoot, requested));
    const relativePath = relative(webRoot, file);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || relativePath.startsWith(sep)) return json(res, 403, { error: "Forbidden" });
    const content = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", "permissions-policy": "camera=(self), microphone=(), geolocation=()" });
    res.end(content);
  } catch (error) {
    if (error?.message === "body-too-large") return json(res, 413, { error: "Request is too large" });
    if (error?.message === "media-too-large") return json(res, 413, { error: "Media must be 20 MB or smaller" });
    if (error instanceof SyntaxError) return json(res, 400, { error: "Invalid JSON" });
    if (error?.code === "ENOENT") return json(res, 404, { error: "Not found" });
    json(res, 500, { error: "Internal server error" });
  }
});

const cleanup = setInterval(() => {
  for (const [id, room] of rooms) if (room.expiresAt <= Date.now()) rooms.delete(id);
}, 60_000);
cleanup.unref();

server.listen(port, "127.0.0.1", () => console.log(`Private link chat ready at http://127.0.0.1:${port}`));
