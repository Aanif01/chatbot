# Quiet Chat

**Open the hosted chat:** [private-link-chat.quiet-chat.workers.dev](https://private-link-chat.quiet-chat.workers.dev)

## Quick guide to share

1. **Create a room.** Open the site, choose **Create a conversation link**, and enter your name.
2. **Invite people.** Copy the invitation link from the room and send it privately to the people you want to join. Keep your own browser address private; it contains the room creator’s discard key.
3. **Join.** Each invited person opens the invitation, chooses a display name, and joins. Anyone with the full invitation link can enter the room.
4. **Chat and share media.** Send messages or attach an image, audio, or video file up to 1.5 MB. Images use **View once** by default; each participant can open the image once in their browser session. Other participants still get their own view.
5. **End the room.** The creator chooses **Discard room** to end it for everyone and erase the room’s stored messages and media. Guests can choose **Leave room** to leave on their device. Rooms also expire after one hour.

**Privacy in brief:** Messages and media are encrypted in the browser before upload. The service stores encrypted content until the room is discarded or expires. Names are not verified. View once limits repeat viewing in the same browser session, but it cannot prevent screenshots, recordings, or someone opening the link in another browser or device.

---

## Project notes

This repository contains the modular foundation for a multi-participant chat opened through a temporary invitation link. It intentionally contains no user-specific or private source material.

## Privacy goal

The intended design is end-to-end encrypted: the browser creates and holds the conversation key, encrypts messages before sending them, and puts the key in the URL fragment (`#...`). URL fragments are not sent in HTTP requests. The service should receive only an opaque conversation identifier and ciphertext. Never put the key in a URL path/query, API request, server log, analytics event, or database.

The prototype implements browser-side AES-GCM encryption, a local HTTP relay, and a Cloudflare Worker/Durable Object relay for hosted use. Hosted rooms have a one-hour expiry, SQLite-backed ciphertext history, and WebSocket delivery. The creator has a separate signing key in their browser link; the copied invitation link does not include it. Only the creator can discard the room, while guests can leave on their device. Display names are visible to the chat service while connected and are not verified identities. It is not production-secure: anyone with an invitation link can read and send messages, there is no anti-abuse system, and participants can choose misleading names. Review the threat model and cryptographic protocol before using it for sensitive conversations. Discarding deletes server-side room storage; it cannot erase copies, screenshots, browser history, or data already received by a participant.

## Modules

- `domain`: conversation and message types plus lifecycle rules.
- `application`: use-case interfaces independent of web framework/storage.
- `ports`: storage, clock, and cryptography contracts.
- `adapters`: future database and transport implementations.
- `cloudflare`: Worker API router and per-room Durable Object.
- `server`: minimal local HTTP relay.
- `web`: browser chat UI and client-side crypto.

The browser client should own encryption/decryption. Server-side adapters should treat message bodies as opaque bytes and avoid logging them.

## Local setup

Requires Node.js 20+ and npm.

```sh
npm start
```

Then open http://127.0.0.1:3000. This Node relay is for same-device development; its WebSocket connection falls back to polling, and its room state is lost when the process stops. `npm run dev` restarts the relay when server files change.

## Cloudflare free deployment

Requires a Cloudflare account, Node.js 20+, and npm. Wrangler serves the static app and routes `/api/*` to a Worker; each conversation is assigned its own SQLite-backed Durable Object.

```sh
npm install
npm run cf:dev
```

Open the local Wrangler URL it prints and verify the room flow with two browser windows. Local development does not require signing into Cloudflare. When you are ready to deploy, sign in and deploy:

```sh
npx wrangler login
npm run cf:deploy
```

Wrangler prints the public HTTPS URL. Share only the invitation link shown in the room; keep the creator's browser address private because it contains the creator-only discard key. The Durable Object's alarm expires and deletes the room after one hour; **Discard room** deletes it immediately for everyone, while **Leave room** clears only a guest's local view. The Worker configuration and SQLite migration live in `wrangler.jsonc`.

Free-plan quotas apply. If a quota is exhausted, requests may fail until it resets; free hosting is not an uptime or capacity guarantee. Keep an eye on the Cloudflare dashboard for usage. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Suggested implementation order

1. Have the cryptographic protocol independently reviewed before sharing sensitive content.
2. Add controls against spam and automated room creation, and decide how to prevent sender-label impersonation.
3. Add optional participant identity verification and clear warnings for forwarded/reused links.
4. Monitor Cloudflare quotas and define an incident/contact process before public launch.

## Prototype limits

The local Node relay stores ciphertext in process memory. The hosted relay stores ciphertext in per-room Durable Object SQLite storage until expiry or deletion. Room IDs are unguessable but act as access capabilities. There is no authentication, identity verification, or public abuse protection. The hosted UI uses WebSockets and falls back to polling when live connections are unavailable. Do not use this prototype for sensitive conversations.
