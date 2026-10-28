import { revokeConversation } from "../domain/conversation.js";
import type { Clock, ConversationRepository, InvitationRepository, MessageRepository } from "../ports/repositories.js";

export interface RevokeConversationInput {
  readonly conversationId: string;
}

/** Revokes new access and requests deletion of stored ciphertext. */
export async function revokeConversationUseCase(
  input: RevokeConversationInput,
  deps: {
    conversations: ConversationRepository;
    invitations: InvitationRepository;
    messages: MessageRepository;
    clock: Clock;
  },
): Promise<void> {
  const conversation = await deps.conversations.find(input.conversationId);
  if (!conversation) return;

  const revoked = revokeConversation(conversation, deps.clock.now());
  await deps.conversations.save(revoked);
  await deps.invitations.revokeForConversation(input.conversationId);
  await deps.messages.deleteForConversation(input.conversationId);
}
