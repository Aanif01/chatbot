# Private link chat — foundation

This repository is a modular starting point for a two-person chat opened through a one-time, expiring link. It intentionally contains no user-specific or private source material.

## Privacy goal

The intended design is end-to-end encrypted: the browser creates and holds the conversation key, encrypts messages before sending them, and puts the key in the URL fragment (`#...`). URL fragments are not sent in HTTP requests. The service should receive only an opaque conversation identifier and ciphertext. Never put the key in a URL path/query, API request, server log, analytics event, or database.

This scaffold does **not** implement encryption, authentication, persistence, link creation, or a network server. It is not production-secure yet. Before real use, implement and review the crypto protocol, key exchange/invitation flow, abuse controls, TLS, rate limits, secure browser storage policy, and deletion behavior. “Discard link” should revoke the invitation and trigger bounded deletion of server-side ciphertext; it cannot erase copies, screenshots, browser history, or data already received by a participant.

## Modules

- `domain`: conversation and message types plus lifecycle rules.
- `application`: use-case interfaces independent of web framework/storage.
- `ports`: storage, clock, and cryptography contracts.
- `adapters`: future database, transport, and crypto implementations.
- `config`: validated runtime configuration (to be added with a server adapter).

The browser client should own encryption/decryption. Server-side adapters should treat message bodies as opaque bytes and avoid logging them.

## Local setup

Requires Node.js 20+ and npm.

```sh
npm install
npm run typecheck
```

No external packages are required for the initial type-only scaffold.

## Suggested implementation order

1. Define and threat-model the invitation flow. Generate high-entropy random link secrets in the client; store only a hash of any server-validated invitation token.
2. Implement reviewed, standard-library/Web Crypto primitives and a versioned message envelope. Do not design custom cryptography.
3. Add a transport adapter that accepts only validated opaque ciphertext, applies size/rate limits, and never logs secrets or message payloads.
4. Add short-lived storage with server-enforced expiry and explicit revocation; document backup and retention behavior.
5. Add a minimal browser UI, security review, and automated checks before deployment.

## Current status

Architecture and domain contracts only. No chat service is running and no messages or links can be created yet.
