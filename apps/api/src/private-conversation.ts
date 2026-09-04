import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { canonicalPair, isParticipant } from './privacy.js';

type ConversationRecord = {
  id: string;
  participantOneId: string;
  participantTwoId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CLOSED';
};

async function pairIsBlocked(tx: Prisma.TransactionClient, participantOneId: string, participantTwoId: string) {
  return Boolean(await tx.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: participantOneId, blockedUserId: participantTwoId },
        { blockerId: participantTwoId, blockedUserId: participantOneId }
      ]
    },
    select: { id: true }
  }));
}

/**
 * Serializes state changes for a canonical user pair. Every path that creates a
 * private message or block takes this PostgreSQL transaction lock before making
 * its final authorization decision, so a concurrent block cannot race a send.
 */
export async function lockPrivatePair(tx: Prisma.TransactionClient, firstUserId: string, secondUserId: string) {
  const [participantOneId, participantTwoId] = canonicalPair(firstUserId, secondUserId);
  const key = `binger:private-pair:${participantOneId}:${participantTwoId}`;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

async function findAcceptedConversationForUser(tx: Prisma.TransactionClient, conversationId: string, userId: string): Promise<ConversationRecord | null> {
  return tx.privateConversation.findFirst({
    where: {
      id: conversationId,
      status: 'ACCEPTED',
      OR: [{ participantOneId: userId }, { participantTwoId: userId }]
    },
    select: { id: true, participantOneId: true, participantTwoId: true, status: true }
  });
}

/** Returns an accepted conversation only while neither participant has blocked the other. */
export async function findAvailablePrivateConversation(tx: Prisma.TransactionClient, conversationId: string, userId: string): Promise<ConversationRecord | null> {
  const preliminary = await findAcceptedConversationForUser(tx, conversationId, userId);
  if (!preliminary) return null;

  await lockPrivatePair(tx, preliminary.participantOneId, preliminary.participantTwoId);
  const conversation = await findAcceptedConversationForUser(tx, conversationId, userId);
  if (!conversation || !isParticipant(conversation, userId)) return null;
  return await pairIsBlocked(tx, conversation.participantOneId, conversation.participantTwoId) ? null : conversation;
}

export async function getAvailablePrivateConversation(conversationId: string, userId: string) {
  return prisma.$transaction(tx => findAvailablePrivateConversation(tx, conversationId, userId));
}

export async function createPrivateTextMessage(conversationId: string, senderId: string, content: string) {
  return prisma.$transaction(async tx => {
    const conversation = await findAvailablePrivateConversation(tx, conversationId, senderId);
    if (!conversation) return null;
    const message = await tx.privateMessage.create({
      data: { conversationId: conversation.id, senderId, content, kind: 'TEXT' }
    });
    return { conversation, message };
  });
}

export async function closePrivateConversationsForBlock(tx: Prisma.TransactionClient, blockerId: string, blockedUserId: string) {
  await lockPrivatePair(tx, blockerId, blockedUserId);
  await tx.userBlock.upsert({
    where: { blockerId_blockedUserId: { blockerId, blockedUserId } },
    update: {},
    create: { blockerId, blockedUserId }
  });
  await tx.privateConversation.updateMany({
    where: {
      status: { in: ['PENDING', 'ACCEPTED'] },
      OR: [
        { participantOneId: blockerId, participantTwoId: blockedUserId },
        { participantOneId: blockedUserId, participantTwoId: blockerId }
      ]
    },
    data: { status: 'CLOSED', closedAt: new Date() }
  });
}
