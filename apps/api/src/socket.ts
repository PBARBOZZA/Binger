import type { Server } from 'socket.io';
import { Prisma } from '@prisma/client';
import cookie from 'cookie';
import { prisma } from './db.js';
import { hash, SESSION_COOKIE } from './security.js';
import { canonicalPair, isBlockedEitherWay, otherParticipantId } from './privacy.js';
import { validateMessage } from './api-routes.js';
import { closePrivateConversationsForBlock, createPrivateTextMessage, getAvailablePrivateConversation, lockPrivatePair } from './private-conversation.js';
import { setPrivateEventEmitter } from './private-events.js';
import { PUBLIC_IMAGE_REJECTION_MESSAGE } from './private-media.js';

type Presence = { userId: string; nickname: string; ageRange: string };
const messageTimes = new Map<string, number[]>();
const presence = new Map<string, Map<string, Presence>>();

function withinRateLimit(store: Map<string, number[]>, key: string, limit: number) {
  const now = Date.now(); const recent = (store.get(key) ?? []).filter(time => now - time < 60_000);
  if (recent.length >= limit) return false;
  recent.push(now); store.set(key, recent); return true;
}

function emitToUsers(io: Server, userIds: string[], event: string, data: unknown) {
  for (const id of new Set(userIds)) io.to(`user:${id}`).emit(event, data);
}

export function configureSocket(io: Server) {
  setPrivateEventEmitter((userIds, event, payload) => emitToUsers(io, userIds, event, payload));
  io.use(async (socket, next) => {
    try {
      const token = cookie.parse(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
      if (!token) return next(new Error('unauthorized'));
      const session = await prisma.session.findUnique({ where: { tokenHash: hash(token) }, include: { user: { include: { profile: true } } } });
      if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE' || !session.user.profile) return next(new Error('unauthorized'));
      socket.data.user = session.user; socket.data.sessionId = session.id; next();
    } catch { next(new Error('unauthorized')); }
  });

  io.on('connection', socket => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    socket.emit('connection:status', { connected: true });

    socket.on('room:join', async (roomId: string, ack) => {
      try {
        const room = await prisma.room.findFirst({ where: { id: roomId, active: true, city: { active: true } } });
        if (!room || user.profile.cityId !== room.cityId) return ack?.({ error: 'Sala indisponível.' });
        for (const name of socket.rooms) if (name.startsWith('room:') && name !== `room:${room.id}`) await socket.leave(name);
        await socket.join(`room:${room.id}`);
        const roomPresence = presence.get(room.id) ?? new Map();
        roomPresence.set(socket.id, { userId: user.id, nickname: user.profile.nickname, ageRange: user.profile.ageRange }); presence.set(room.id, roomPresence);
        io.to(`room:${room.id}`).emit('room:participants', [...new Map([...roomPresence.values()].map(person => [person.userId, person])).values()]); ack?.({ ok: true });
      } catch { ack?.({ error: 'Não foi possível entrar na sala.' }); }
    });

    socket.on('room:message', async (payload, ack) => {
      try {
        const parsed = validateMessage(payload);
        if ('error' in parsed) return ack?.({ error: parsed.error });
        const roomId = typeof payload?.roomId === 'string' ? payload.roomId : '';
        const room = await prisma.room.findFirst({ where: { id: roomId, active: true, cityId: user.profile.cityId } });
        if (!room || !socket.rooms.has(`room:${room.id}`)) return ack?.({ error: 'Entre na sala antes de enviar.' });
        if (!withinRateLimit(messageTimes, user.id, 12)) return ack?.({ error: 'Limite de mensagens atingido. Aguarde um pouco.' });
        const recipientId = typeof payload?.recipientId === 'string' ? payload.recipientId : null;
        if (recipientId) {
          if (recipientId === user.id || await isBlockedEitherWay(user.id, recipientId)) return ack?.({ error: 'Interação reservada indisponível.' });
          const targetOnline = [...(presence.get(room.id)?.values() ?? [])].some(person => person.userId === recipientId);
          if (!targetOnline) return ack?.({ error: 'A pessoa não está mais nesta sala.' });
          const recipient = await prisma.user.findFirst({ where: { id: recipientId, profile: { cityId: room.cityId } }, select: { id: true, profile: true } });
          if (!recipient) return ack?.({ error: 'Destinatário inválido.' });
          const message = await prisma.roomMessage.create({ data: { roomId: room.id, userId: user.id, recipientId, scope: 'RESERVED', content: parsed.content } });
          emitToUsers(io, [user.id, recipientId], 'room:message:new', { ...message, user: { id: user.id, profile: user.profile }, recipient, blockedForMe: false });
        } else {
          const message = await prisma.roomMessage.create({ data: { roomId: room.id, userId: user.id, scope: 'PUBLIC', content: parsed.content } });
          const blockers = new Set((await prisma.userBlock.findMany({ where: { blockedUserId: user.id }, select: { blockerId: true } })).map(item => item.blockerId));
          for (const target of io.sockets.adapter.rooms.get(`room:${room.id}`) ?? []) io.sockets.sockets.get(target)?.emit('room:message:new', { ...message, user: { id: user.id, profile: user.profile }, recipient: null, blockedForMe: blockers.has(io.sockets.sockets.get(target)?.data.user?.id) });
        }
        ack?.({ ok: true });
      } catch { ack?.({ error: 'Não foi possível enviar a mensagem.' }); }
    });

    socket.on('private:invite', async (input, ack) => {
      try {
        const invitedUserId = typeof input?.invitedUserId === 'string' ? input.invitedUserId : '';
        const invited = await prisma.user.findUnique({ where: { id: invitedUserId }, include: { profile: true } });
        if (!invited?.profile || invited.id === user.id || invited.profile.cityId !== user.profile.cityId || invited.profile.invitationPreference === 'NONE' || await isBlockedEitherWay(user.id, invited.id)) return ack?.({ error: 'Convite indisponível.' });
        if (invited.profile.invitationPreference === 'VERIFIED_ONLY' && !user.emailVerifiedAt) return ack?.({ error: 'Apenas contas confirmadas.' });
        const [participantOneId, participantTwoId] = canonicalPair(user.id, invited.id);
        const conversation = await prisma.$transaction(async tx => {
          await lockPrivatePair(tx, user.id, invited.id);
          const blocked = await tx.userBlock.findFirst({ where: { OR: [{ blockerId: user.id, blockedUserId: invited.id }, { blockerId: invited.id, blockedUserId: user.id }] }, select: { id: true } });
          if (blocked) return null;
          const existing = await tx.privateConversation.findFirst({ where: { participantOneId, participantTwoId, status: { in: ['PENDING', 'ACCEPTED'] } } });
          return existing ?? tx.privateConversation.create({ data: { participantOneId, participantTwoId, requestedById: user.id } });
        });
        if (!conversation) return ack?.({ error: 'Convite indisponível.' });
        if (conversation.status === 'PENDING') emitToUsers(io, [invited.id], 'private:invite', { conversation, from: { id: user.id, profile: user.profile } });
        ack?.({ ok: true, conversationId: conversation.id, status: conversation.status });
      } catch (error) {
        ack?.({ error: error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' ? 'Já existe uma conversa ativa.' : 'Não foi possível criar o convite.' });
      }
    });

    socket.on('private:invite:respond', async (input, ack) => {
      try {
        const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : '';
        const response = await prisma.$transaction(async tx => {
          const preliminary = await tx.privateConversation.findFirst({ where: { id: conversationId, status: 'PENDING', requestedById: { not: user.id }, OR: [{ participantOneId: user.id }, { participantTwoId: user.id }] } });
          if (!preliminary) return null;
          await lockPrivatePair(tx, preliminary.participantOneId, preliminary.participantTwoId);
          const conversation = await tx.privateConversation.findFirst({ where: { id: conversationId, status: 'PENDING', requestedById: { not: user.id }, OR: [{ participantOneId: user.id }, { participantTwoId: user.id }] } });
          if (!conversation) return null;
          if (input?.block === true) {
            await closePrivateConversationsForBlock(tx, user.id, conversation.requestedById);
            return { updated: conversation, accepted: false, blocked: true };
          }
          const blocked = await tx.userBlock.findFirst({ where: { OR: [{ blockerId: user.id, blockedUserId: conversation.requestedById }, { blockerId: conversation.requestedById, blockedUserId: user.id }] }, select: { id: true } });
          const accepted = input?.accept === true && !blocked;
          const updated = await tx.privateConversation.update({ where: { id: conversation.id }, data: accepted ? { status: 'ACCEPTED', acceptedAt: new Date() } : { status: 'REJECTED', closedAt: new Date() } });
          return { updated, accepted, blocked: false };
        });
        if (!response) return ack?.({ error: 'Convite inválido.' });
        emitToUsers(io, [response.updated.participantOneId, response.updated.participantTwoId], response.accepted ? 'private:invite:accepted' : 'private:invite:rejected', response.updated);
        ack?.({ ok: true });
      } catch { ack?.({ error: 'Não foi possível responder ao convite.' }); }
    });

    socket.on('private:join', async (conversationId: string, ack) => {
      const conversation = await getAvailablePrivateConversation(conversationId, user.id);
      if (!conversation) return ack?.({ error: 'Conversa indisponível.' });
      await socket.join(`private:${conversation.id}`); ack?.({ ok: true });
    });

    socket.on('private:message', async (payload, ack) => {
      try {
        const parsed = validateMessage(payload); if ('error' in parsed) return ack?.({ error: parsed.error });
        const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
        if (!socket.rooms.has(`private:${conversationId}`)) return ack?.({ error: 'Conversa indisponível.' });
        if (!withinRateLimit(messageTimes, user.id, 12)) return ack?.({ error: 'Limite de mensagens atingido.' });
        const created = await createPrivateTextMessage(conversationId, user.id, parsed.content);
        if (!created) return ack?.({ error: 'Conversa indisponível.' });
        emitToUsers(io, [created.conversation.participantOneId, created.conversation.participantTwoId], 'private:message:new', { ...created.message, sender: { id: user.id, profile: user.profile } }); ack?.({ ok: true });
      } catch { ack?.({ error: 'Não foi possível enviar a mensagem.' }); }
    });

    socket.on('private:typing', async (payload) => {
      const conversation = await getAvailablePrivateConversation(typeof payload?.conversationId === 'string' ? payload.conversationId : '', user.id);
      if (!conversation) return;
      io.to(`user:${otherParticipantId(conversation, user.id)}`).emit('private:typing', { conversationId: conversation.id, typing: payload?.typing === true });
    });

    socket.on('image:send', (_payload, ack) => {
      // Image bytes are never accepted over Socket.IO. Private uploads use the authenticated HTTP endpoint.
      ack?.({ error: PUBLIC_IMAGE_REJECTION_MESSAGE });
    });

    socket.on('disconnecting', () => {
      for (const roomName of socket.rooms) if (roomName.startsWith('room:')) {
        const id = roomName.slice(5); const list = presence.get(id); list?.delete(socket.id);
        if (list?.size === 0) presence.delete(id);
        io.to(roomName).emit('room:participants', [...new Map([...(list?.values() ?? [])].map(person => [person.userId, person])).values()]);
      }
    });
  });
}
