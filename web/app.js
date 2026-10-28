const $ = (id) => document.getElementById(id);
const welcome = $("welcome");
const chat = $("chat");
const messagesNode = $("messages");
const statusNode = $("status");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let roomId;
let key;
let senderId = sessionStorage.getItem("chat-sender") || crypto.randomUUID();
sessionStorage.setItem("chat-sender", senderId);
let seen = new Set();
let pollTimer;
let socket;
let liveConnection = false;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers }, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function encrypt(text) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encoder.encode(text));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), nonce: bytesToBase64(nonce) };
}
async function decrypt(message) {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(message.nonce) }, key, base64ToBytes(message.ciphertext));
  return decoder.decode(plaintext);
}
async function configureRoom(id, rawKey) {
  roomId = id;
  key = await crypto.subtle.importKey("raw", base64ToBytes(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function showMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  decrypt(message).then((text) => makeBubble(text, message.sender === senderId)).catch(() => {
    statusNode.textContent = "A message could not be decrypted with this link.";
  });
}
function makeBubble(text, mine) {
  const bubble = document.createElement("div");
  bubble.className = `bubble${mine ? " mine" : ""}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = mine ? "You" : "Guest";
  const body = document.createElement("div");
  body.textContent = text;
  bubble.append(who, body);
  messagesNode.append(bubble);
  messagesNode.scrollTop = messagesNode.scrollHeight;
}
async function refresh() {
  if (!roomId) return;
  try {
    const { messages, expiresAt } = await api(`/api/rooms/${roomId}`);
    $("expiry").textContent = `Expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    for (const message of messages) showMessage(message);
    if (!liveConnection) statusNode.textContent = "Encrypted · Checking for messages every 2 seconds";
  } catch (error) {
    if (error.message === "Room not found or expired") {
      cleanRoom("This conversation has ended. Its link and messages have been cleared from this page.");
      return;
    }
    statusNode.textContent = error.message;
    clearInterval(pollTimer);
  }
}
function showRoom({ share = false } = {}) {
  $("notice").classList.add("hidden");
  welcome.classList.add("hidden");
  chat.classList.remove("hidden");
  if (share) $("shareBox").classList.remove("hidden");
  refresh();
  startUpdates();
}
function cleanRoom(message) {
  clearInterval(pollTimer);
  pollTimer = undefined;
  const oldSocket = socket;
  socket = undefined;
  liveConnection = false;
  roomId = undefined;
  key = undefined;
  oldSocket?.close();
  history.replaceState(null, "", location.pathname);
  messagesNode.replaceChildren();
  seen.clear();
  $("shareLink").value = "";
  $("message").value = "";
  $("expiry").textContent = "";
  $("shareBox").classList.add("hidden");
  statusNode.textContent = "";
  chat.classList.add("hidden");
  welcome.classList.remove("hidden");
  $("notice").textContent = message;
  $("notice").classList.remove("hidden");
}
function startUpdates() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!liveConnection) refresh(); }, 2000);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${scheme}//${location.host}/api/rooms/${roomId}/ws`);
  socket.addEventListener("open", () => {
    liveConnection = true;
    statusNode.textContent = "End-to-end encrypted · Live connection";
  });
  socket.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "message") showMessage(frame.message);
    if (frame.type === "ended") {
      const notice = frame.reason === "expired"
        ? "This conversation expired. Its link and messages have been cleared from this page."
        : "This conversation was discarded. Its link and messages have been cleared from this page.";
      cleanRoom(notice);
    }
    if (frame.type === "error") statusNode.textContent = frame.error;
  });
  socket.addEventListener("close", () => {
    if (socket?.readyState === WebSocket.CLOSED) {
      liveConnection = false;
      if (roomId) {
        statusNode.textContent = "Live connection ended · Checking for messages every 2 seconds";
        refresh();
      }
    }
  });
  socket.addEventListener("error", () => {
    liveConnection = false;
    statusNode.textContent = "Live connection unavailable · Using periodic refresh";
  });
}

$("create").addEventListener("click", async () => {
  const button = $("create");
  button.disabled = true;
  try {
    const room = await api("/api/rooms", { method: "POST" });
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    await configureRoom(room.id, bytesToBase64(rawKey));
    const link = new URL(location.href);
    link.hash = `${room.id}.${bytesToBase64(rawKey)}`;
    $("shareLink").value = link.href;
    showRoom({ share: true });
  } catch (error) {
    statusNode.textContent = error.message;
    chat.classList.remove("hidden");
  } finally { button.disabled = false; }
});

$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("shareLink").value); $("copy").textContent = "Copied"; }
  catch { $("shareLink").select(); statusNode.textContent = "Copy is unavailable; select and copy the link manually."; }
});

$("sendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("message");
  const text = input.value.trim();
  if (!text) return;
  try {
    const encrypted = await encrypt(text);
    const message = { ...encrypted, sender: senderId };
    if (liveConnection && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "message", message }));
    } else {
      await api(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(message) });
    }
    input.value = "";
    if (!liveConnection) await refresh();
  } catch (error) { statusNode.textContent = error.message; }
});

$("discard").addEventListener("click", async () => {
  if (!confirm("Discard this room and delete its messages from server memory?")) return;
  try { await api(`/api/rooms/${roomId}`, { method: "DELETE" }); }
  finally { cleanRoom("This conversation was discarded. Its link and messages have been cleared from this page."); }
});

const fragment = location.hash.slice(1);
if (fragment) {
  const separator = fragment.indexOf(".");
  const id = fragment.slice(0, separator);
  const rawKey = fragment.slice(separator + 1);
  if (separator > 0 && rawKey) {
    configureRoom(id, rawKey).then(() => showRoom()).catch(() => { statusNode.textContent = "This link is invalid."; chat.classList.remove("hidden"); });
  } else {
    statusNode.textContent = "This link is invalid.";
    chat.classList.remove("hidden");
  }
}
