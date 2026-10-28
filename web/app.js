const $ = (id) => document.getElementById(id);
const welcome = $("welcome");
const chat = $("chat");
const messagesNode = $("messages");
const statusNode = $("status");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let roomId;
let key;
let ownerPrivateKey;
let senderId = sessionStorage.getItem("chat-sender") || crypto.randomUUID();
sessionStorage.setItem("chat-sender", senderId);
let seen = new Set();
let pollTimer;
let socket;
let heartbeatTimer;
let reconnectTimer;
let reconnectAttempt = 0;
let liveConnection = false;
let displayName = sessionStorage.getItem("chat-name") || "";
let participantNames = new Map();
let joinedRoom = false;
let replyTarget;
let mediaUrls = new Set();
let viewerTimer;
let onceViewerUrl;
const MAX_MEDIA_BYTES = 1_500_000;

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
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
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
async function configureRoom(id, rawKey, rawOwnerKey) {
  roomId = id;
  key = await crypto.subtle.importKey("raw", base64ToBytes(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  ownerPrivateKey = rawOwnerKey
    ? await crypto.subtle.importKey("pkcs8", base64ToBytes(rawOwnerKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    : undefined;
}
function showMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);
  decrypt(message).then((plaintext) => {
    let text = plaintext;
    let name = participantNames.get(message.sender) || "Guest";
    let reply;
    let media;
    try {
      const content = JSON.parse(plaintext);
      if (typeof content.text === "string" && typeof content.name === "string") {
        text = content.text;
        name = content.name;
        if (content.media && typeof content.media.id === "string" && typeof content.media.nonce === "string") media = content.media;
        if (content.reply && typeof content.reply.id === "string" && typeof content.reply.text === "string") {
          reply = {
            id: content.reply.id,
            name: typeof content.reply.name === "string" ? content.reply.name : "Guest",
            text: content.reply.text,
          };
        }
      }
    } catch { /* older messages contained plain text */ }
    makeBubble(text, message.sender === senderId, name, message.id, reply, media);
  }).catch(() => {
    statusNode.textContent = "A message could not be decrypted with this link.";
  });
}
function makeBubble(text, mine, name, messageId, reply, media) {
  const bubble = document.createElement("div");
  bubble.className = `bubble${mine ? " mine" : ""}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = mine ? `You · ${name}` : name;
  bubble.append(who);
  if (reply) {
    const quote = document.createElement("div");
    quote.className = "reply-quote";
    const quotedName = document.createElement("strong");
    quotedName.textContent = `Reply to ${reply.name}`;
    const quotedText = document.createElement("span");
    quotedText.textContent = reply.text;
    quote.append(quotedName, quotedText);
    bubble.append(quote);
  }
  if (text) {
    const body = document.createElement("div");
    body.textContent = text;
    bubble.append(body);
  }
  if (media) {
    bubble.dataset.mediaId = media.id;
    renderMedia(bubble, media);
  }
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.className = "reply-message";
  replyButton.textContent = "Reply";
  replyButton.addEventListener("click", () => setReplyTarget({ id: messageId, name, text: text || "Media" }));
  bubble.append(replyButton);
  messagesNode.append(bubble);
  messagesNode.scrollTop = messagesNode.scrollHeight;
}
async function renderMedia(bubble, media) {
  if (media.viewOnce) {
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "view-once-button";
    viewButton.textContent = "View image once";
    viewButton.addEventListener("click", () => openViewOnceImage(bubble, media, viewButton));
    bubble.insertBefore(viewButton, bubble.querySelector(".reply-message"));
    const hint = document.createElement("div");
    hint.className = "media-caption";
    hint.textContent = "One view per participant · cleared when the room ends";
    bubble.insertBefore(hint, bubble.querySelector(".reply-message"));
    return;
  }
  const placeholder = document.createElement("div");
  placeholder.className = "media-loading";
  placeholder.textContent = "Decrypting media…";
  bubble.insertBefore(placeholder, bubble.querySelector(".reply-message"));
  try {
    const response = await fetch(`/api/rooms/${roomId}/media/${media.id}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Media is unavailable");
    const encrypted = await response.arrayBuffer();
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(media.nonce) }, key, encrypted);
    const isImage = media.type.startsWith("image/");
    const objectUrl = isImage
      ? `data:${media.type};base64,${bytesToBase64(new Uint8Array(clear))}`
      : URL.createObjectURL(new Blob([clear], { type: media.type }));
    if (!isImage) mediaUrls.add(objectUrl);
    const preview = media.type.startsWith("image/") ? document.createElement("img")
      : media.type.startsWith("video/") ? document.createElement("video") : document.createElement("audio");
    preview.className = "media-preview";
    preview.src = objectUrl;
    preview.alt = media.type.startsWith("image/") ? (media.name || "Shared image") : "";
    if (preview instanceof HTMLMediaElement) {
      preview.controls = true;
      preview.playsInline = true;
      preview.controlsList = "nodownload noremoteplayback";
      if (preview instanceof HTMLVideoElement) preview.disablePictureInPicture = true;
    }
    placeholder.replaceWith(preview);
    if (preview instanceof HTMLImageElement) {
      preview.tabIndex = 0;
      preview.setAttribute("role", "button");
      preview.setAttribute("aria-label", "Open image larger");
      preview.addEventListener("click", () => showImageViewer(objectUrl, false));
      preview.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") showImageViewer(objectUrl, false); });
    }
    const caption = document.createElement("div");
    caption.className = "media-caption";
    caption.textContent = `${media.name || "Shared media"} · ${formatBytes(media.size)}`;
    preview.after(caption);
  } catch {
    placeholder.textContent = "This media is unavailable.";
  }
}
async function openViewOnceImage(bubble, media, button) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    const response = await fetch(`/api/rooms/${roomId}/media/${media.id}/consume`, {
      method: "POST", headers: { "x-viewer-id": senderId }, cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 410 ? "This image was already viewed." : "This image is no longer available.");
    const encrypted = await response.arrayBuffer();
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(media.nonce) }, key, encrypted);
    const objectUrl = `data:${media.type};base64,${bytesToBase64(new Uint8Array(clear))}`;
    onceViewerUrl = objectUrl;
    button.textContent = "Opened · view once";
    showImageViewer(objectUrl, true);
  } catch (error) {
    button.textContent = error.message;
    button.classList.add("view-once-ended");
  }
}
function showImageViewer(objectUrl, viewOnce) {
  const viewer = $("mediaViewer");
  clearTimeout(viewerTimer);
  $("viewerImage").src = objectUrl;
  $("viewerLabel").textContent = viewOnce ? "View once · 10 seconds" : "Image preview";
  $("viewerNotice").textContent = viewOnce ? "Your view is one-time. The encrypted room copy remains for other participants until the room ends." : "";
  if (!viewer.open) viewer.showModal();
  if (viewOnce) viewerTimer = setTimeout(closeImageViewer, 10_000);
}
function closeImageViewer() {
  clearTimeout(viewerTimer);
  viewerTimer = undefined;
  const viewer = $("mediaViewer");
  if (viewer.open) viewer.close();
  $("viewerImage").removeAttribute("src");
  if (onceViewerUrl) {
    if (onceViewerUrl.startsWith("blob:")) URL.revokeObjectURL(onceViewerUrl);
    mediaUrls.delete(onceViewerUrl);
    onceViewerUrl = undefined;
  }
}
function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function setReplyTarget(target) {
  replyTarget = target;
  $("replyingName").textContent = `Replying to ${target.name}`;
  $("replyingText").textContent = target.text.length > 180 ? `${target.text.slice(0, 180)}…` : target.text;
  $("replyingTo").classList.remove("hidden");
  $("message").focus();
}
function clearReply() {
  replyTarget = undefined;
  $("replyingName").textContent = "";
  $("replyingText").textContent = "";
  $("replyingTo").classList.add("hidden");
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
  $("identity").classList.remove("hidden");
  $("roomContent").classList.add("hidden");
  $("displayName").value = displayName;
  $("roomAction").textContent = ownerPrivateKey ? "Discard room" : "Leave room";
  $("ownerDiscard").classList.toggle("hidden", !ownerPrivateKey);
}
function cleanRoom(message, { keepFragment = false } = {}) {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  pollTimer = undefined;
  heartbeatTimer = undefined;
  reconnectTimer = undefined;
  const oldSocket = socket;
  socket = undefined;
  liveConnection = false;
  roomId = undefined;
  key = undefined;
  ownerPrivateKey = undefined;
  joinedRoom = false;
  oldSocket?.close();
  for (const url of mediaUrls) URL.revokeObjectURL(url);
  mediaUrls.clear();
  closeImageViewer();
  if (!keepFragment) history.replaceState(null, "", location.pathname);
  messagesNode.replaceChildren();
  seen.clear();
  clearReply();
  participantNames.clear();
  $("participantCount").textContent = "0 here";
  $("participants").textContent = "";
  $("discardConfirm").classList.add("hidden");
  $("ownerDiscard").classList.add("hidden");
  $("identity").classList.remove("hidden");
  $("roomContent").classList.add("hidden");
  $("shareLink").value = "";
  $("message").value = "";
  $("mediaInput").value = "";
  $("viewOnceOption").classList.add("hidden");
  $("viewOnce").checked = true;
  $("mediaHint").textContent = "Attach an image, audio, or video · up to 1.5 MB · encrypted before upload";
  $("expiry").textContent = "";
  $("shareBox").classList.add("hidden");
  statusNode.textContent = "";
  chat.classList.add("hidden");
  welcome.classList.remove("hidden");
  $("notice").textContent = message;
  $("notice").classList.remove("hidden");
}
function startUpdates() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!liveConnection) refresh(); }, 2000);
  if (location.protocol !== "https:") {
    $("participantCount").textContent = "Count unavailable";
    $("participants").textContent = "Live count is available on the hosted chat";
    statusNode.textContent = "Using periodic refresh";
    return;
  }
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(`${scheme}//${location.host}/api/rooms/${roomId}/ws`);
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) { connection.close(); return; }
    liveConnection = true;
    reconnectAttempt = 0;
    statusNode.textContent = "End-to-end encrypted · Live connection";
    if (joinedRoom) {
      connection.send(JSON.stringify({ type: "join", sender: senderId, name: displayName, heartbeat: true }));
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (socket === connection && connection.readyState === WebSocket.OPEN) {
          try { connection.send(JSON.stringify({ type: "heartbeat" })); } catch { /* reconnect after close */ }
        }
      }, 15000);
    }
  });
  connection.addEventListener("message", (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "message") showMessage(frame.message);
    if (frame.type === "presence") {
      participantNames = new Map(frame.participants.map((person) => [person.sender, person.name]));
      $("participantCount").textContent = `${frame.participants.length} here`;
      $("participants").textContent = frame.participants.length
        ? `Here now: ${frame.participants.map((person) => person.name).join(", ")}`
        : "No one connected";
    }
    if (frame.type === "ended") {
      const notice = frame.reason === "expired"
        ? "This conversation expired. Its link and messages have been cleared from this page."
        : "This conversation was discarded. Its link and messages have been cleared from this page.";
      cleanRoom(notice);
    }
    if (frame.type === "error") statusNode.textContent = frame.error;
  });
  connection.addEventListener("close", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (socket === connection) {
      liveConnection = false;
      if (roomId) {
        $("participantCount").textContent = "Reconnecting…";
        $("participants").textContent = "Restoring live participant list";
        statusNode.textContent = "Live connection ended · Reconnecting";
        refresh();
        if (joinedRoom && !reconnectTimer) {
          const delay = Math.min(1000 * (2 ** reconnectAttempt), 10000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (roomId && joinedRoom) startUpdates();
          }, delay);
        }
      }
    }
  });
  connection.addEventListener("error", () => {
    liveConnection = false;
    $("participantCount").textContent = "Reconnecting…";
    $("participants").textContent = "Restoring live participant list";
    statusNode.textContent = "Live connection unavailable · Using periodic refresh";
  });
}

$("identity").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("displayName").value.trim().replace(/\s+/g, " ");
  if (!name) return;
  displayName = name.slice(0, 24);
  sessionStorage.setItem("chat-name", displayName);
  $("identity").classList.add("hidden");
  $("roomContent").classList.remove("hidden");
  if (!joinedRoom) {
    joinedRoom = true;
    $("participantCount").textContent = "Connecting…";
    refresh();
    startUpdates();
  } else if (liveConnection && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "join", sender: senderId, name: displayName, heartbeat: true }));
  }
});

$("changeName").addEventListener("click", () => {
  $("displayName").value = displayName;
  $("join").textContent = "Update name";
  $("roomContent").classList.add("hidden");
  $("identity").classList.remove("hidden");
  $("displayName").focus();
});

$("create").addEventListener("click", async () => {
  const button = $("create");
  button.disabled = true;
  try {
    const ownerKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ownerPublicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", ownerKeys.publicKey)));
    const ownerRawKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", ownerKeys.privateKey)));
    const room = await api("/api/rooms", { method: "POST", body: JSON.stringify({ ownerPublicKey }) });
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const encodedKey = bytesToBase64(rawKey);
    await configureRoom(room.id, encodedKey, ownerRawKey);
    const inviteLink = new URL(location.href);
    inviteLink.hash = `${room.id}.${encodedKey}`;
    const ownerLink = new URL(inviteLink.href);
    ownerLink.hash = `${room.id}.${encodedKey}.${ownerRawKey}`;
    history.replaceState(null, "", ownerLink.href);
    $("shareLink").value = inviteLink.href;
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
  const file = $("mediaInput").files[0];
  if (!text && !file) return;
  try {
    const content = { text, name: displayName };
    if (file) {
      if (!/^(image|audio|video)\//.test(file.type)) throw new Error("Choose an image, audio, or video file.");
      if (file.size > MAX_MEDIA_BYTES) throw new Error("Media must be 1.5 MB or smaller.");
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encryptedBytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, await file.arrayBuffer());
      const mediaId = crypto.randomUUID();
      const viewOnce = file.type.startsWith("image/") && $("viewOnce").checked;
      const upload = await fetch(`/api/rooms/${roomId}/media/${mediaId}`, { method: "PUT", headers: { "content-type": "application/octet-stream", ...(viewOnce ? { "x-media-view-once": "true" } : {}) }, body: encryptedBytes, cache: "no-store" });
      if (!upload.ok) {
        const result = await upload.json().catch(() => ({}));
        throw new Error(result.error || "Could not upload media.");
      }
      content.media = { id: mediaId, nonce: bytesToBase64(nonce), name: file.name.slice(0, 180), type: file.type, size: file.size, viewOnce };
    }
    if (replyTarget) {
      content.reply = {
        id: replyTarget.id,
        name: replyTarget.name,
        text: replyTarget.text.length > 180 ? `${replyTarget.text.slice(0, 180)}…` : replyTarget.text,
      };
    }
    const encrypted = await encrypt(JSON.stringify(content));
    const message = { ...encrypted, sender: senderId };
    if (liveConnection && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "message", message }));
    } else {
      await api(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(message) });
    }
    input.value = "";
    $("mediaInput").value = "";
    $("viewOnceOption").classList.add("hidden");
    $("viewOnce").checked = true;
    $("mediaHint").textContent = "Attach an image, audio, or video · up to 1.5 MB · encrypted before upload";
    clearReply();
    if (!liveConnection) await refresh();
  } catch (error) { statusNode.textContent = error.message; }
});

$("mediaInput").addEventListener("change", () => {
  const file = $("mediaInput").files[0];
  if (!file) return;
  if (!/^(image|audio|video)\//.test(file.type)) {
    $("mediaInput").value = "";
    $("mediaHint").textContent = "Choose an image, audio, or video file.";
  } else if (file.size > MAX_MEDIA_BYTES) {
    $("mediaInput").value = "";
    $("mediaHint").textContent = "Media must be 1.5 MB or smaller.";
  } else {
    const isImage = file.type.startsWith("image/");
    $("viewOnceOption").classList.toggle("hidden", !isImage);
    $("viewOnce").checked = isImage;
    $("mediaHint").textContent = `${file.name} · ${formatBytes(file.size)} ready to send`;
  }
});

$("closeViewer").addEventListener("click", closeImageViewer);
$("mediaViewer").addEventListener("click", (event) => { if (event.target === $("mediaViewer")) closeImageViewer(); });
$("mediaViewer").addEventListener("close", () => {
  if (onceViewerUrl) {
    if (onceViewerUrl.startsWith("blob:")) URL.revokeObjectURL(onceViewerUrl);
    mediaUrls.delete(onceViewerUrl);
    onceViewerUrl = undefined;
  }
  clearTimeout(viewerTimer);
  $("viewerImage").removeAttribute("src");
});

$("cancelReply").addEventListener("click", clearReply);

$("roomAction").addEventListener("click", async () => {
  if (!ownerPrivateKey) {
    cleanRoom("You left the conversation on this device. The room is still open for others.");
    return;
  }
  $("discardConfirm").classList.remove("hidden");
});

$("ownerDiscard").addEventListener("click", () => {
  $("discardConfirm").classList.remove("hidden");
});

$("cancelDiscard").addEventListener("click", () => {
  $("discardConfirm").classList.add("hidden");
});

$("confirmDiscard").addEventListener("click", async () => {
  const button = $("confirmDiscard");
  button.disabled = true;
  try {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, ownerPrivateKey, encoder.encode(`discard:${roomId}`),
    );
    await api(`/api/rooms/${roomId}`, { method: "DELETE", body: JSON.stringify({ signature: bytesToBase64(new Uint8Array(signature)) }) });
    cleanRoom("This conversation was discarded. Its link and messages have been cleared from this page.");
  } catch (error) {
    statusNode.textContent = error.message;
    $("discardConfirm").classList.add("hidden");
  } finally { button.disabled = false; }
});

async function openLinkedRoom() {
  const fragment = location.hash.slice(1);
  if (!fragment) return;
  const [id, rawKey, rawOwnerKey] = fragment.split(".");
  const separator = fragment.indexOf(".");
  if (separator <= 0 || !rawKey) {
    statusNode.textContent = "This link is invalid.";
    chat.classList.remove("hidden");
    return;
  }
  try {
    await configureRoom(id, rawKey, rawOwnerKey);
    await api(`/api/rooms/${id}`);
    showRoom();
  } catch (error) {
    if (error.status === 404 || error.message === "Room not found or expired") {
      cleanRoom("This invitation has expired or the room has been discarded.");
    } else if (roomId) {
      cleanRoom("This invitation is unavailable. Check your connection or return to the hosted chat page to create a new room.");
    } else {
      statusNode.textContent = "This link is invalid.";
      chat.classList.remove("hidden");
    }
  }
}

if (location.hash) openLinkedRoom();
window.addEventListener("hashchange", () => {
  if (!location.hash) return;
  const targetId = location.hash.slice(1).split(".")[0];
  if (roomId && roomId !== targetId) cleanRoom("Opening the linked conversation…", { keepFragment: true });
  if (!roomId) openLinkedRoom();
});
