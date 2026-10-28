# Private link chat — foundation

This repository is a modular starting point for a two-person chat opened through a one-time, expiring link. It intentionally contains no user-specific or private source material.

## Privacy goal

The intended design is end-to-end encrypted: the browser creates and holds the conversation key, encrypts messages before sending them, and puts the key in the URL fragment (`#...`). URL fragments are not sent in HTTP requests. The service should receive only an opaque conversation identifier and ciphertext. Never put the key in a URL path/query, API request, server log, analytics event, or database.

The prototype implements browser-side AES-GCM encryption, a local HTTP relay, and a Cloudflare Worker/Durable Object relay for hosted use. Hosted rooms have a one-hour expiry, SQLite-backed ciphertext history, and WebSocket delivery. It is not production-secure: random room IDs act as bearer capabilities, there is no identity verification or anti-abuse system, and clients sharing a link can impersonate a sender label. Review the threat model and cryptographic protocol before using it for sensitive conversations. “Discard room” deletes server-side room storage; it cannot erase copies, screenshots, browser history, or data already received by a participant.

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

Wrangler prints the public HTTPS URL. Share a generated conversation link from that URL. The Durable Object's alarm expires and deletes the room after one hour; **Discard room** deletes it immediately. The Worker configuration and SQLite migration live in `wrangler.jsonc`.

Free-plan quotas apply. If a quota is exhausted, requests may fail until it resets; free hosting is not an uptime or capacity guarantee. Keep an eye on the Cloudflare dashboard for usage. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Suggested implementation order

1. Have the cryptographic protocol independently reviewed before sharing sensitive content.
2. Add controls against spam and automated room creation, and decide how to prevent sender-label impersonation.
3. Add optional participant identity verification and clear warnings for forwarded/reused links.
4. Monitor Cloudflare quotas and define an incident/contact process before public launch.

## Prototype limits

The local Node relay stores ciphertext in process memory. The hosted relay stores ciphertext in per-room Durable Object SQLite storage until expiry or deletion. Room IDs are unguessable but act as access capabilities. There is no authentication, identity verification, or public abuse protection. The hosted UI uses WebSockets and falls back to polling when live connections are unavailable. Do not use this prototype for sensitive conversations.
