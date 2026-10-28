import type { ConversationId } from "./conversation.js";

/** Ciphertext only. Plaintext and keys must never cross the server boundary. */
export interface EncryptedMessage {
  readonly id: string;
  readonly conversationId: ConversationId;
  readonly senderId: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly protocolVersion: number;
  readonly sentAt: number;
}

export function validateEncryptedMessage(message: EncryptedMessage): void {
  if (!message.id || !message.conversationId || !message.senderId) {
    throw new TypeError("Message identifiers are required");
  }
  if (message.ciphertext.byteLength === 0) {
    throw new TypeError("Ciphertext must not be empty");
  }
  if (message.protocolVersion < 1 || !Number.isSafeInteger(message.protocolVersion)) {
    throw new TypeError("Unsupported protocol version");
  }
  if (!Number.isFinite(message.sentAt)) throw new TypeError("Invalid sent time");
}
