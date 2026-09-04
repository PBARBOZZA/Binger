import express, { Router } from 'express';
import { prisma } from './db.js';
import { cleanText, hasUrl, ipHash, requireAuth, requireRole } from './security.js';
import { messageSchema } from './validation.js';
import { config } from './config.js';
import { closePrivateConversationsForBlock, findAvailablePrivateConversation } from './private-conversation.js';
import {
  applyPrivateMediaHeaders,
  createPrivateImageMessage,
  deletePrivateMessageForEveryone,
  PrivateMediaError,
  readAuthorizedPrivateMedia
} from './private-media.js';
import { emitPrivateEvent } from './private-events.js';

export const apiRouter = Router();
apiRouter.get('/cities', async (_req, res) => {
  const cities = await prisma.city.findMany({ where: { active: true }, include: { rooms: { where: { active: true }, select: { id: true, name: true, slug: true } } }, orderBy: { name: 'asc' } });
  res.json(cities.map(city => ({ ...city, onlineCount: 0 })));
});

apiRouter.get('/rooms/:id/messages', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const room = await prisma.room.findFirst({ where: { id: String(req.params.id), active: true, city: { active: true, profiles: { some: { userId } } } } });
  if (!room) return res.status(404).json({ error: 'Sala indisponível.' });
  const [messages, blocks] = await Promise.all([
    prisma.roomMessage.findMany({ where: { roomId: room.id, deletedAt: null, moderationStatus: 'VISIBLE', OR: [{ scope: 'PUBLIC' }, { userId }, { recipientId: userId }] }, include: { user: { select: { id: true, profile: true } }, recipient: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.userBlock.findMany({ where: { blockerId: userId }, select: { blockedUserId: true } })
  ]);
  const hidden = new Set(blocks.map(block => block.blockedUserId));
  res.json(messages.reverse().map(message => ({ ...message, blockedForMe: message.scope === 'PUBLIC' && hidden.has(message.userId) })));
});

apiRouter.get('/blocks', requireAuth, async (req, res) => {
  const blocks = await prisma.userBlock.findMany({ where: { blockerId: req.auth!.userId }, include: { blocked: { select: { id: true, profile: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(blocks.map(block => ({ id: block.id, createdAt: block.createdAt, user: block.blocked })));
});
apiRouter.post('/blocks/:userId', requireAuth, async (req, res) => {
  const blockerId = req.auth!.userId; const blockedUserId = String(req.params.userId);
  if (blockedUserId === blockerId || !await prisma.user.findUnique({ where: { id: blockedUserId }, select: { id: true } })) return res.status(400).json({ error: 'Ação inválida.' });
  await prisma.$transaction(tx => closePrivateConversationsForBlock(tx, blockerId, blockedUserId));
  res.status(201).json({ message: 'Usuário bloqueado.' });
});
apiRouter.delete('/blocks/:userId', requireAuth, async (req, res) => {
  await prisma.userBlock.deleteMany({ where: { blockerId: req.auth!.userId, blockedUserId: String(req.params.userId) } });
  res.status(204).end();
});

apiRouter.post('/mutes/:userId', requireAuth, async (req, res) => {
  const muterId = req.auth!.userId; const mutedUserId = String(req.params.userId);
  if (muterId === mutedUserId) return res.status(400).json({ error: 'Ação inválida.' });
  await prisma.userMute.upsert({ where: { muterId_mutedUserId: { muterId, mutedUserId } }, update: {}, create: { muterId, mutedUserId } });
  res.status(201).json({ message: 'Usuário silenciado.' });
});
apiRouter.delete('/mutes/:userId', requireAuth, async (req, res) => {
  await prisma.userMute.deleteMany({ where: { muterId: req.auth!.userId, mutedUserId: String(req.params.userId) } });
  res.status(204).end();
});

apiRouter.get('/private-conversations', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const conversations = await prisma.privateConversation.findMany({ where: { OR: [{ participantOneId: userId }, { participantTwoId: userId }], status: { in: ['PENDING', 'ACCEPTED'] } }, include: { participantOne: { select: { id: true, profile: true } }, participantTwo: { select: { id: true, profile: true } }, messages: { where: { senderId: { not: userId }, readAt: null, deletedAt: null }, select: { id: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(conversations.map(({ messages, ...conversation }) => ({ ...conversation, unreadCount: messages.length })));
});
apiRouter.get('/private-conversations/:id', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const conversation = await prisma.privateConversation.findFirst({
    where: { id: String(req.params.id), OR: [{ participantOneId: userId }, { participantTwoId: userId }], status: { in: ['PENDING', 'ACCEPTED'] } },
    include: { participantOne: { select: { id: true, profile: true } }, participantTwo: { select: { id: true, profile: true } } }
  });
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json(conversation);
});
apiRouter.get('/private-conversations/:id/messages', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const messages = await prisma.$transaction(async tx => {
    const conversation = await findAvailablePrivateConversation(tx, String(req.params.id), userId);
    if (!conversation) return null;
    const result = await tx.privateMessage.findMany({
      where: { conversationId: conversation.id, deletedAt: null, moderationStatus: 'VISIBLE' },
      include: {
        sender: { select: { id: true, profile: true } },
        media: { select: { id: true, mimeType: true, byteSize: true, width: true, height: true, createdAt: true, expiresAt: true } }
      },
      orderBy: { createdAt: 'asc' },
      take: 100
    });
    await tx.privateMessage.updateMany({ where: { conversationId: conversation.id, senderId: { not: userId }, readAt: null }, data: { readAt: new Date() } });
    return result;
  });
  if (!messages) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json(messages);
});
apiRouter.post('/private-conversations/:id/images', requireAuth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'], limit: config.PRIVATE_MEDIA_MAX_BYTES }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Imagem inválida.' });
  try {
    const created = await createPrivateImageMessage({
      conversationId: String(req.params.id),
      authorId: req.auth!.userId,
      ipKey: ipHash(req.ip ?? ''),
      bytes: req.body
    });
    const message = { ...created.message, media: created.media };
    emitPrivateEvent(
      [created.conversation.participantOneId, created.conversation.participantTwoId],
      'private:media:new',
      { message, media: created.media }
    );
    res.status(201).json({ message, media: created.media });
  } catch (error) {
    if (error instanceof PrivateMediaError && error.code === 'UNAVAILABLE') return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (error instanceof PrivateMediaError && error.code === 'RATE_LIMITED') return res.status(429).json({ error: 'Limite de imagens atingido. Aguarde um pouco.' });
    if (error instanceof PrivateMediaError && ['INVALID_IMAGE', 'LIMIT_EXCEEDED'].includes(error.code)) return res.status(400).json({ error: 'Imagem inválida ou fora dos limites permitidos.' });
    return res.status(500).json({ error: 'Não foi possível enviar a imagem.' });
  }
});
apiRouter.get('/private-images/:id', requireAuth, async (req, res) => {
  const media = await readAuthorizedPrivateMedia(String(req.params.id), req.auth!.userId);
  // Deliberately use the same response for missing, expired, deleted, blocked and unauthorized media.
  if (!media) return res.status(404).json({ error: 'Mídia não encontrada.' });
  applyPrivateMediaHeaders(res, media.mimeType);
  res.status(200).send(media.bytes);
});
apiRouter.delete('/private-messages/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await deletePrivateMessageForEveryone(String(req.params.id), req.auth!.userId);
    if (!deleted) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    emitPrivateEvent([deleted.participantOneId, deleted.participantTwoId], 'private:message:deleted', { conversationId: deleted.conversationId, messageId: String(req.params.id) });
    res.status(204).end();
  } catch (error) {
    if (error instanceof PrivateMediaError && error.code === 'DELETE_NOT_ALLOWED') return res.status(403).json({ error: 'O prazo para apagar esta mensagem expirou.' });
    return res.status(500).json({ error: 'Não foi possível apagar a mensagem.' });
  }
});
apiRouter.post('/private-conversations/:id/close', requireAuth, async (req, res) => {
  const conversation = await prisma.privateConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conversation || (conversation.participantOneId !== req.auth!.userId && conversation.participantTwoId !== req.auth!.userId)) return res.status(404).json({ error: 'Conversa não encontrada.' });
  await prisma.privateConversation.update({ where: { id: conversation.id }, data: { status: 'CLOSED', closedAt: new Date() } });
  res.status(204).end();
});

apiRouter.post('/reports', requireAuth, async (req, res) => {
  const { reportedUserId, roomMessageId, privateMessageId, reason, description } = req.body ?? {};
  if (typeof reportedUserId !== 'string' || typeof reason !== 'string' || reportedUserId === req.auth!.userId) return res.status(400).json({ error: 'Dados da denúncia inválidos.' });
  const priority = reason === 'MINOR_SUSPECTED' ? 'CRITICAL' : ['THREAT', 'FRAUD'].includes(reason) ? 'HIGH' : 'NORMAL';
  const report = await prisma.report.create({ data: { reporterId: req.auth!.userId, reportedUserId, roomMessageId, privateMessageId, reason: cleanText(reason).slice(0, 60), description: typeof description === 'string' ? cleanText(description).slice(0, 500) : null, priority } });
  res.status(201).json(report);
});
apiRouter.get('/moderation/reports', requireAuth, requireRole('MODERATOR', 'ADMIN'), async (_req, res) => res.json(await prisma.report.findMany({ include: { reporter: { select: { id: true, profile: true } }, reportedUser: { select: { id: true, profile: true } }, roomMessage: true, privateMessage: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }] })));
apiRouter.patch('/admin/cities/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const city = await prisma.city.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'CITY_STATUS_CHANGED', targetType: 'City', targetId: city.id, metadata: { active: city.active } } }); res.json(city);
});
apiRouter.patch('/admin/rooms/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const room = await prisma.room.update({ where: { id: String(req.params.id) }, data: { active: Boolean(req.body?.active) } });
  await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'ROOM_STATUS_CHANGED', targetType: 'Room', targetId: room.id, metadata: { active: room.active } } }); res.json(room);
});

export function validateMessage(input: unknown) {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) return { error: 'A mensagem deve ter entre 1 e 500 caracteres.' } as const;
  const content = cleanText(parsed.data.content);
  if (!content) return { error: 'A mensagem não pode estar vazia.' } as const;
  if (hasUrl(content)) return { error: 'Links não são permitidos no MVP.' } as const;
  return { content } as const;
}
