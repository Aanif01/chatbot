export type ConversationId = string;
export type InvitationId = string;

export interface Conversation {
  readonly id: ConversationId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export function isConversationActive(conversation: Conversation, now: number): boolean {
  return conversation.revokedAt === undefined && now < conversation.expiresAt;
}

export function revokeConversation(conversation: Conversation, now: number): Conversation {
  if (!Number.isFinite(now) || now < conversation.createdAt) {
    throw new RangeError("Revocation time must be a valid time after creation");
  }
  if (conversation.revokedAt !== undefined) return conversation;
  return { ...conversation, revokedAt: now };
}
