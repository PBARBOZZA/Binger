import type { Server } from 'socket.io';
import cookie from 'cookie';
import { prisma } from './db.js';
import { hash, SESSION_COOKIE } from './security.js';
import { validateMessage } from './api-routes.js';

const lastMessages = new Map<string, number[]>();
const presence = new Map<string, Map<string, { userId: string; nickname: string; ageRange: string }>>();

export function configureSocket(io: Server) {
  io.use(async (socket, next) => {
    try {
      const token = cookie.parse(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
      if (!token) return next(new Error('unauthorized'));
      const session = await prisma.session.findUnique({ where: { tokenHash: hash(token) }, include: { user: { include: { profile: true } } } });
      if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.profile) return next(new Error('unauthorized'));
      socket.data.user = session.user;
      next();
    } catch { next(new Error('unauthorized')); }
  });

  io.on('connection', socket => {
    const user = socket.data.user;
    socket.emit('connection:status', { connected: true });
    socket.on('room:join', async (roomId: string, ack) => {
      const room = await prisma.room.findFirst({ where: { id: roomId, active: true, city: { active: true } } });
      if (!room || user.profile.cityId !== room.cityId) return ack?.({ error: 'Sala indisponível.' });
      await socket.join(`room:${room.id}`);
      const roomPresence = presence.get(room.id) ?? new Map();
      roomPresence.set(socket.id, { userId: user.id, nickname: user.profile.nickname, ageRange: user.profile.ageRange });
      presence.set(room.id, roomPresence);
      io.to(`room:${room.id}`).emit('room:participants', [...new Map([...roomPresence.values()].map(p => [p.userId, p])).values()]);
      ack?.({ ok: true });
    });
    socket.on('room:message', async (payload, ack) => {
      const parsed = validateMessage(payload);
      if ('error' in parsed) return ack?.({ error: parsed.error });
      const room = await prisma.room.findFirst({ where: { id: payload.roomId, active: true, city: { active: true } } });
      if (!room || !socket.rooms.has(`room:${room.id}`)) return ack?.({ error: 'Entre na sala antes de enviar.' });
      const now = Date.now(); const recent = (lastMessages.get(user.id) ?? []).filter(t => now - t < 60_000);
      if (recent.length >= 12) return ack?.({ error: 'Limite de mensagens atingido. Aguarde um pouco.' });
      recent.push(now); lastMessages.set(user.id, recent);
      const message = await prisma.roomMessage.create({ data: { roomId: room.id, userId: user.id, content: parsed.content } });
      io.to(`room:${room.id}`).emit('room:message:new', { ...message, user: { id: user.id, profile: user.profile } });
      ack?.({ ok: true });
    });
    socket.on('private:invite', async ({ invitedUserId }, ack) => {
      const invited = await prisma.user.findUnique({ where: { id: invitedUserId }, include: { profile: true } });
      if (!invited?.profile || invited.id === user.id || invited.profile.invitationPreference === 'NONE') return ack?.({ error: 'Convite indisponível.' });
      if (invited.profile.invitationPreference === 'VERIFIED_ONLY' && !user.emailVerifiedAt) return ack?.({ error: 'Apenas contas confirmadas.' });
      const conversation = await prisma.privateConversation.create({ data: { createdById: user.id, invitedUserId } });
      for (const target of io.sockets.sockets.values()) if (target.data.user?.id === invitedUserId) target.emit('private:invite', { conversation, from: user.profile });
      ack?.({ ok: true, conversationId: conversation.id });
    });
    socket.on('private:invite:respond', async ({ conversationId, accept }, ack) => {
      const conversation = await prisma.privateConversation.findFirst({ where: { id: conversationId, invitedUserId: user.id, status: 'PENDING' } });
      if (!conversation) return ack?.({ error: 'Convite inválido.' });
      const updated = await prisma.privateConversation.update({ where: { id: conversation.id }, data: accept ? { status: 'ACCEPTED', acceptedAt: new Date() } : { status: 'REJECTED', closedAt: new Date() } });
      io.to(`user:${conversation.createdById}`).emit(accept ? 'private:invite:accepted' : 'private:invite:rejected', updated);
      ack?.({ ok: true });
    });
    socket.on('disconnecting', () => {
      for (const roomName of socket.rooms) if (roomName.startsWith('room:')) {
        const id = roomName.slice(5); const list = presence.get(id); list?.delete(socket.id);
        if (list) io.to(roomName).emit('room:participants', [...new Map([...list.values()].map(p => [p.userId, p])).values()]);
      }
    });
    socket.join(`user:${user.id}`);
  });
}
