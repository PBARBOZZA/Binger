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
import { findActiveRoom } from './rooms.js';
import { roomMessageSchema } from './validation.js';
import { beginParticipation, endParticipation, getParticipation, roomMessageView } from './room-participation.js';

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

    function emitPresence(roomId: string) {
      const participants = [...new Map([...(presence.get(roomId)?.values() ?? [])].map(person => [person.userId, person])).values()];
      io.to(`room:${roomId}`).emit('room:presence', { roomId, participants });
      // Preserve the old wire format while clients are updated during rollout.
      io.to(`room:${roomId}`).emit('room:participants', participants);
    }

    function removePresence(roomId: string) {
      const list = presence.get(roomId);
      list?.delete(socket.id);
      if (!list?.size) presence.delete(roomId);
      emitPresence(roomId);
    }

    // Serialize joins and sends per connection: concurrent joins must never leave
    // a socket subscribed to two public rooms or send using a stale membership.
    let roomOperations = Promise.resolve();
    function onRoomEvent(event: string, handler: (input: unknown, ack: (reply: unknown) => void) => Promise<void>) {
      socket.on(event, (input, callback) => {
        const ack = typeof callback === 'function' ? callback : () => {};
        roomOperations = roomOperations.then(async () => {
          if (!socket.connected) return;
          const session = await prisma.session.findUnique({ where: { id: socket.data.sessionId }, include: { user: true } });
          if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
            ack({ error: 'Sessão inválida ou expirada.' });
            socket.disconnect(true);
            return;
          }
          await handler(input, ack);
        }).catch(() => { ack({ error: 'Não foi possível concluir a operação na sala.' }); });
      });
    }

    async function leaveRoom() {
      endParticipation(socket.data.participationId);
      delete socket.data.participationId;
      for (const name of [...socket.rooms]) if (name.startsWith('room:')) {
        await socket.leave(name);
        removePresence(name.slice(5));
      }
    }

    onRoomEvent('room:leave', async (_input, ack) => {
      await leaveRoom();
      ack({ ok: true });
    });

    onRoomEvent('room:join', async (reference, ack) => {
      await leaveRoom();
      const room = await findActiveRoom(reference);
      if (!room) return ack({ error: 'Sala indisponível.' });
      if (!socket.connected) return;
      const participation = await beginParticipation(socket.id, socket.data.sessionId, user.id, room.id);
      socket.data.participationId = participation.id;
      if (!socket.connected) { endParticipation(participation.id); return; }
      try { await socket.join(`room:${room.id}`); }
      catch (error) { endParticipation(participation.id); throw error; }
      if (!socket.connected) { endParticipation(participation.id); await socket.leave(`room:${room.id}`); return; }
      const roomPresence = presence.get(room.id) ?? new Map();
      roomPresence.set(socket.id, { userId: user.id, nickname: user.profile.nickname, ageRange: user.profile.ageRange });
      presence.set(room.id, roomPresence);
      emitPresence(room.id);
      ack({ ok: true, roomId: room.id, participationId: participation.id, joinedAt: participation.joinedAt });
    });

    onRoomEvent('room:message', async (payload, ack) => {
      const envelope = roomMessageSchema.safeParse(payload);
      if (!envelope.success) return ack({ error: 'Mensagem inválida. Envie apenas texto e selecione uma sala.' });
      const parsed = validateMessage(envelope.data);
      if ('error' in parsed) return ack({ error: parsed.error });
      const room = await findActiveRoom(envelope.data.roomId);
      if (!room || !socket.rooms.has(`room:${room.id}`) || !getParticipation(socket.data.participationId, socket.data.sessionId, user.id, room.id)) return ack({ error: 'Entre em uma sala ativa antes de enviar.' });
      if (!withinRateLimit(messageTimes, user.id, 12)) return ack({ error: 'Limite de mensagens atingido. Aguarde um pouco.' });
      const recipientId = envelope.data.recipientId ?? null;
      if (recipientId) {
        if (recipientId === user.id || await isBlockedEitherWay(user.id, recipientId)) return ack({ error: 'Interação reservada indisponível.' });
        const targetOnline = [...(presence.get(room.id)?.values() ?? [])].some(person => person.userId === recipientId);
        if (!targetOnline) return ack({ error: 'A pessoa não está mais nesta sala.' });
        const recipient = await prisma.user.findFirst({ where: { id: recipientId, status: 'ACTIVE' }, select: { id: true, profile: true } });
        if (!recipient?.profile) return ack({ error: 'Destinatário inválido.' });
        const message = await prisma.roomMessage.create({ data: { roomId: room.id, userId: user.id, recipientId, scope: 'RESERVED', content: parsed.content } });
        // Intersect room membership with the two recipients, including other tabs.
        // User-wide channels would leak reserved room events into another city.
        for (const targetId of io.sockets.adapter.rooms.get(`room:${room.id}`) ?? []) {
          const target = io.sockets.sockets.get(targetId);
          const participation = target && getParticipation(target.data.participationId, target.data.sessionId, target.data.user?.id, room.id);
          if (target && participation && message.position > participation.after && [user.id, recipientId].includes(target.data.user?.id)) target.emit('room:message:new', { ...roomMessageView(message), participationId: participation.id, user: { id: user.id, profile: user.profile }, recipient, blockedForMe: false });
        }
      } else {
        const message = await prisma.roomMessage.create({ data: { roomId: room.id, userId: user.id, scope: 'PUBLIC', content: parsed.content } });
        const blockers = new Set((await prisma.userBlock.findMany({ where: { blockedUserId: user.id }, select: { blockerId: true } })).map(item => item.blockerId));
        for (const targetId of io.sockets.adapter.rooms.get(`room:${room.id}`) ?? []) {
          const target = io.sockets.sockets.get(targetId);
          const participation = target && getParticipation(target.data.participationId, target.data.sessionId, target.data.user?.id, room.id);
          if (target && participation && message.position > participation.after) target.emit('room:message:new', { ...roomMessageView(message), participationId: participation.id, user: { id: user.id, profile: user.profile }, recipient: null, blockedForMe: blockers.has(target.data.user?.id) });
        }
      }
      ack({ ok: true });
    });

    socket.on('private:invite', async (input, ack) => {
      try {
        const invitedUserId = typeof input?.invitedUserId === 'string' ? input.invitedUserId : '';
        const invited = await prisma.user.findUnique({ where: { id: invitedUserId }, include: { profile: true } });
        if (!invited?.profile || invited.status !== 'ACTIVE' || invited.id === user.id || invited.profile.invitationPreference === 'NONE' || await isBlockedEitherWay(user.id, invited.id)) return ack?.({ error: 'Convite indisponível.' });
        // Preserve existing same-profile-city invitations; visitors from another
        // city may invite each other only when they meet in the same active room.
        if (invited.profile.cityId !== user.profile.cityId) {
          const sharedRoom = [...socket.rooms].find(name => name.startsWith('room:') && [...(presence.get(name.slice(5))?.values() ?? [])].some(person => person.userId === invited.id));
          if (!sharedRoom || !await findActiveRoom(sharedRoom.slice(5))) return ack?.({ error: 'Entre na mesma sala para enviar este convite.' });
        }
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
      endParticipation(socket.data.participationId);
      for (const roomName of socket.rooms) if (roomName.startsWith('room:')) {
        removePresence(roomName.slice(5));
      }
    });
  });
}
