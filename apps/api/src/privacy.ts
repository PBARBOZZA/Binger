import { prisma } from './db.js';

export const canonicalPair = (a: string, b: string): [string, string] => a < b ? [a, b] : [b, a];

export const isParticipant = (conversation: { participantOneId: string; participantTwoId: string }, userId: string) =>
  conversation.participantOneId === userId || conversation.participantTwoId === userId;

export const otherParticipantId = (conversation: { participantOneId: string; participantTwoId: string }, userId: string) =>
  conversation.participantOneId === userId ? conversation.participantTwoId : conversation.participantOneId;

export async function isBlockedEitherWay(a: string, b: string) {
  return Boolean(await prisma.userBlock.findFirst({ where: { OR: [
    { blockerId: a, blockedUserId: b }, { blockerId: b, blockedUserId: a }
  ] }, select: { id: true } }));
}

export function canSeeRoomMessage(message: { userId: string; recipientId: string | null; scope: 'PUBLIC' | 'RESERVED' }, userId: string) {
  return message.scope === 'PUBLIC' || message.userId === userId || message.recipientId === userId;
}

export function allowedImageType(bytes: Uint8Array) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  const pngEnd = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (bytes.length >= 20 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a && pngEnd.every((value, index) => bytes[bytes.length - 12 + index] === value)) return 'image/png';
  if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const declaredSize = bytes[4]! | bytes[5]! << 8 | bytes[6]! << 16 | bytes[7]! << 24;
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (declaredSize === bytes.length - 8 && ['VP8 ', 'VP8L', 'VP8X'].includes(chunk)) return 'image/webp';
  }
  return null;
}
