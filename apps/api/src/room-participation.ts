import { randomUUID } from 'node:crypto';
import { prisma } from './db.js';

type Participation = {
  id: string; socketId: string; sessionId: string; userId: string; roomId: string;
  joinedAt: Date; after: bigint;
};
// Deliberately connection-scoped. Disconnect/restart fails closed and requires a
// new participation; an account's other tabs never inherit this window.
const participations = new Map<string, Participation>();
export async function beginParticipation(socketId: string, sessionId: string, userId: string, roomId: string) {
  const [boundary] = await prisma.$queryRaw<{ after: bigint; joinedAt: Date }[]>`
    SELECT nextval('"RoomMessage_position_seq"') AS "after", clock_timestamp() AS "joinedAt"`;
  if (!boundary) throw new Error('Não foi possível registrar o ingresso.');
  const participation = { id: randomUUID(), socketId, sessionId, userId, roomId, ...boundary };
  participations.set(participation.id, participation);
  return participation;
}
export function endParticipation(id: unknown) {
  if (typeof id === 'string') participations.delete(id);
}
export function getParticipation(id: unknown, sessionId: string, userId: string, roomId: string) {
  const participation = typeof id === 'string' ? participations.get(id) : undefined;
  return participation?.sessionId === sessionId && participation.userId === userId && participation.roomId === roomId ? participation : undefined;
}
export function roomMessageView<T extends { position: bigint }>(message: T) {
  const { position: _position, ...view } = message;
  return view;
}
