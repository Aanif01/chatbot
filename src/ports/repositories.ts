import type { Conversation, ConversationId } from "../domain/conversation.js";
import type { EncryptedMessage } from "../domain/message.js";

export interface ConversationRepository {
  find(id: ConversationId): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}

export interface MessageRepository {
  append(message: EncryptedMessage): Promise<void>;
  list(conversationId: ConversationId, after?: string): Promise<readonly EncryptedMessage[]>;
  deleteForConversation(conversationId: ConversationId): Promise<void>;
}

/** Persist a digest only; never persist or log the invitation secret itself. */
export interface InvitationRepository {
  consume(secretDigest: Uint8Array, now: number): Promise<ConversationId | undefined>;
  revokeForConversation(conversationId: ConversationId): Promise<void>;
}

export interface Clock {
  now(): number;
}
