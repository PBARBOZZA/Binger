import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import type { SharpConstructor } from 'sharp';
import { config } from './config.js';
import { prisma } from './db.js';
import { isParticipant } from './privacy.js';
import { findAvailablePrivateConversation, lockPrivatePair } from './private-conversation.js';

export const PRIVATE_MEDIA_RATE_WINDOW_MS = 60_000;
export const PRIVATE_MEDIA_STAGING_GRACE_MS = 5 * 60_000;
export const PUBLIC_IMAGE_REJECTION_MESSAGE = 'Imagens só podem ser enviadas em conversas privadas.';
const storageKeyPattern = /^[a-f0-9]{64}\.webp$/;
const temporaryStorageFilePattern = /^\.[a-f0-9]{64}\.webp\.[a-f0-9]{32}\.tmp$/;
const stagingDirectoryName = '.staging';

export type PrivateMediaMime = 'image/jpeg' | 'image/png' | 'image/webp';
export type PrivateMediaLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
};
export type NormalizedPrivateImage = {
  bytes: Buffer;
  mimeType: 'image/webp';
  width: number;
  height: number;
};
export type PrivateMediaFailureCode = 'INVALID_IMAGE' | 'LIMIT_EXCEEDED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'DELETE_NOT_ALLOWED' | 'STORAGE_FAILURE';

export class PrivateMediaError extends Error {
  constructor(public readonly code: PrivateMediaFailureCode) {
    super(code);
  }
}

export const privateMediaLimitsFromConfig = (): PrivateMediaLimits => ({
  maxBytes: config.PRIVATE_MEDIA_MAX_BYTES,
  maxWidth: config.PRIVATE_MEDIA_MAX_WIDTH,
  maxHeight: config.PRIVATE_MEDIA_MAX_HEIGHT,
  maxPixels: config.PRIVATE_MEDIA_MAX_PIXELS
});

/** The upload Content-Type is never trusted; only these byte signatures may reach the decoder. */
export function detectPrivateImageMime(bytes: Uint8Array): PrivateMediaMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

type SharpFactory = SharpConstructor;

async function loadSharp(): Promise<SharpFactory> {
  const imported = await import('sharp');
  return imported.default;
}

function decoderMime(format: string | undefined): PrivateMediaMime | null {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return null;
}

function dimensionsWithinLimits(width: number, height: number, limits: PrivateMediaLimits) {
  return width > 0 && height > 0 && width <= limits.maxWidth && height <= limits.maxHeight && width * height <= limits.maxPixels;
}

/**
 * Decodes the image for real and always emits a fresh WebP. Sharp does not copy
 * EXIF/XMP/IPTC metadata unless withMetadata() is explicitly requested, so this
 * strips location and other original metadata while rotate() applies orientation.
 */
export async function normalizePrivateImage(input: Buffer, limits: PrivateMediaLimits = privateMediaLimitsFromConfig(), sharpFactory: () => Promise<SharpFactory> = loadSharp): Promise<NormalizedPrivateImage> {
  if (input.length === 0 || !detectPrivateImageMime(input)) throw new PrivateMediaError('INVALID_IMAGE');
  if (input.length > limits.maxBytes) throw new PrivateMediaError('LIMIT_EXCEEDED');

  try {
    const sharp = await sharpFactory();
    const metadata = await sharp(input, { failOn: 'error', limitInputPixels: limits.maxPixels }).metadata();
    const magicMime = detectPrivateImageMime(input);
    if (!magicMime || decoderMime(metadata.format) !== magicMime || !metadata.width || !metadata.height) {
      throw new PrivateMediaError('INVALID_IMAGE');
    }
    if (!dimensionsWithinLimits(metadata.width, metadata.height, limits)) throw new PrivateMediaError('LIMIT_EXCEEDED');

    const normalized = await sharp(input, { failOn: 'error', limitInputPixels: limits.maxPixels })
      .rotate()
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (normalized.info.format !== 'webp' || !dimensionsWithinLimits(normalized.info.width, normalized.info.height, limits)) {
      throw new PrivateMediaError('LIMIT_EXCEEDED');
    }
    if (normalized.data.length === 0 || normalized.data.length > limits.maxBytes) throw new PrivateMediaError('LIMIT_EXCEEDED');
    return { bytes: normalized.data, mimeType: 'image/webp', width: normalized.info.width, height: normalized.info.height };
  } catch (error) {
    if (error instanceof PrivateMediaError) throw error;
    throw new PrivateMediaError('INVALID_IMAGE');
  }
}

export function createPrivateMediaStorageKey() {
  return `${randomBytes(32).toString('hex')}.webp`;
}

export function privateMediaPath(mediaRoot: string, storageKey: string) {
  if (!storageKeyPattern.test(storageKey) || basename(storageKey) !== storageKey) throw new PrivateMediaError('STORAGE_FAILURE');
  const root = resolve(mediaRoot);
  const target = resolve(root, storageKey);
  if (dirname(target) !== root) throw new PrivateMediaError('STORAGE_FAILURE');
  return target;
}

function privateMediaStagingRoot(mediaRoot: string) {
  const root = resolve(mediaRoot);
  const stagingRoot = resolve(root, stagingDirectoryName);
  if (dirname(stagingRoot) !== root) throw new PrivateMediaError('STORAGE_FAILURE');
  return stagingRoot;
}

export async function writePrivateMediaFile(mediaRoot: string, storageKey: string, bytes: Buffer) {
  const target = privateMediaPath(mediaRoot, storageKey);
  const root = dirname(target);
  const temporary = resolve(root, `.${storageKey}.${randomBytes(16).toString('hex')}.tmp`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { encoding: undefined, mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new PrivateMediaError('STORAGE_FAILURE');
  }
}

/** Promotes an already-written staging file without allowing a collision to overwrite another image. */
export async function promotePrivateMediaFile(mediaRoot: string, storageKey: string) {
  const staged = privateMediaPath(privateMediaStagingRoot(mediaRoot), storageKey);
  const target = privateMediaPath(mediaRoot, storageKey);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await link(staged, target);
  } catch {
    throw new PrivateMediaError('STORAGE_FAILURE');
  }
  try {
    await unlink(staged);
  } catch {
    await unlink(target).catch(() => undefined);
    throw new PrivateMediaError('STORAGE_FAILURE');
  }
}

export async function readPrivateMediaFile(mediaRoot: string, storageKey: string) {
  try {
    return await readFile(privateMediaPath(mediaRoot, storageKey));
  } catch {
    return null;
  }
}

/** Returns true when the file is gone, including an already-removed file. */
export async function removePrivateMediaFile(mediaRoot: string, storageKey: string) {
  try {
    await unlink(privateMediaPath(mediaRoot, storageKey));
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}

export class PrivateMediaRateLimiter {
  private readonly windows = new Map<string, number[]>();

  private prune(now: number) {
    for (const [key, timestamps] of this.windows) {
      const live = timestamps.filter(time => now - time < PRIVATE_MEDIA_RATE_WINDOW_MS);
      if (live.length === 0) this.windows.delete(key);
      else this.windows.set(key, live);
    }
  }

  consume(input: { userId: string; conversationId: string; ipKey: string }, limits: { user: number; conversation: number; ip: number }, now = Date.now()) {
    this.prune(now);
    const entries = [
      [`user:${input.userId}`, limits.user],
      [`conversation:${input.conversationId}`, limits.conversation],
      [`ip:${input.ipKey}`, limits.ip]
    ] as const;
    const current = entries.map(([key]) => (this.windows.get(key) ?? []).filter(time => now - time < PRIVATE_MEDIA_RATE_WINDOW_MS));
    if (current.some((times, index) => times.length >= entries[index]![1])) return false;
    entries.forEach(([key], index) => {
      current[index]!.push(now);
      this.windows.set(key, current[index]!);
    });
    return true;
  }
}

export const privateMediaRateLimiter = new PrivateMediaRateLimiter();

type MediaRecordForResponse = {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: Date;
  expiresAt: Date;
};

/** Metadata deliberately excludes physical storage keys and any bearer token. */
export function privateMediaDto(media: MediaRecordForResponse) {
  return {
    id: media.id,
    mimeType: media.mimeType,
    byteSize: media.byteSize,
    width: media.width,
    height: media.height,
    createdAt: media.createdAt,
    expiresAt: media.expiresAt
  };
}

export function privateMessageDeleteUntil(createdAt: Date) {
  return new Date(createdAt.getTime() + config.PRIVATE_MESSAGE_DELETE_WINDOW_MINUTES * 60_000);
}

export const privateMediaHeaders = (mimeType: string) => ({
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Content-Type': mimeType
});

export function applyPrivateMediaHeaders(res: Response, mimeType: string) {
  res.set(privateMediaHeaders(mimeType));
}

export function canReadPrivateMedia(input: {
  userId: string;
  blocked: boolean;
  conversation: { participantOneId: string; participantTwoId: string; status: string };
  message: { kind: string; deletedAt: Date | null; moderationStatus: string };
  media: { storedAt: Date | null; deletedAt: Date | null; purgedAt: Date | null; expiresAt: Date };
}, now = new Date()) {
  return input.conversation.status === 'ACCEPTED'
    && isParticipant(input.conversation, input.userId)
    && !input.blocked
    && input.message.kind === 'IMAGE'
    && input.message.deletedAt === null
    && input.message.moderationStatus === 'VISIBLE'
    && input.media.storedAt !== null
    && input.media.deletedAt === null
    && input.media.purgedAt === null
    && input.media.expiresAt > now;
}

async function findLiveMedia(tx: Prisma.TransactionClient, mediaId: string) {
  return tx.privateMedia.findFirst({
    where: { id: mediaId, storedAt: { not: null }, deletedAt: null, purgedAt: null, expiresAt: { gt: new Date() } },
    include: { conversation: true, message: true }
  });
}

export async function readAuthorizedPrivateMedia(mediaId: string, userId: string) {
  return prisma.$transaction(async tx => {
    let media = await findLiveMedia(tx, mediaId);
    if (!media) return null;

    await lockPrivatePair(tx, media.conversation.participantOneId, media.conversation.participantTwoId);
    media = await findLiveMedia(tx, mediaId);
    if (!media) return null;
    const blocked = Boolean(await tx.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: media.conversation.participantOneId, blockedUserId: media.conversation.participantTwoId },
          { blockerId: media.conversation.participantTwoId, blockedUserId: media.conversation.participantOneId }
        ]
      },
      select: { id: true }
    }));
    if (!canReadPrivateMedia({ userId, blocked, conversation: media.conversation, message: media.message, media })) return null;
    const bytes = await readPrivateMediaFile(config.PRIVATE_MEDIA_ROOT, media.storageKey);
    return bytes ? { bytes, mimeType: media.mimeType } : null;
  });
}

export async function createPrivateImageMessage(input: { conversationId: string; authorId: string; ipKey: string; bytes: Buffer }) {
  // Check the pair before adding any client-controlled identifier to the rate-limit store.
  const availableConversation = await prisma.$transaction(tx => findAvailablePrivateConversation(tx, input.conversationId, input.authorId));
  if (!availableConversation) throw new PrivateMediaError('UNAVAILABLE');

  const normalized = await normalizePrivateImage(input.bytes);
  const withinLimit = privateMediaRateLimiter.consume({
    userId: input.authorId,
    conversationId: availableConversation.id,
    ipKey: input.ipKey
  }, {
    user: config.PRIVATE_MEDIA_USER_LIMIT,
    conversation: config.PRIVATE_MEDIA_CONVERSATION_LIMIT,
    ip: config.PRIVATE_MEDIA_IP_LIMIT
  });
  if (!withinLimit) throw new PrivateMediaError('RATE_LIMITED');

  const storageKey = createPrivateMediaStorageKey();
  const stagingRoot = privateMediaStagingRoot(config.PRIVATE_MEDIA_ROOT);
  await writePrivateMediaFile(stagingRoot, storageKey, normalized.bytes);

  const created = await prisma.$transaction(async tx => {
    // The preflight above only protects rate-limit memory. Authorization is checked
    // again under the pair lock immediately before the metadata is persisted.
    const conversation = await findAvailablePrivateConversation(tx, input.conversationId, input.authorId);
    if (!conversation) throw new PrivateMediaError('UNAVAILABLE');
    const now = new Date();
    const message = await tx.privateMessage.create({
      data: { conversationId: conversation.id, senderId: input.authorId, kind: 'IMAGE', content: '' },
      include: { sender: { select: { id: true, profile: true } } }
    });
    const media = await tx.privateMedia.create({
      data: {
        conversationId: conversation.id,
        messageId: message.id,
        authorId: input.authorId,
        storageKey,
        mimeType: normalized.mimeType,
        byteSize: normalized.bytes.length,
        width: normalized.width,
        height: normalized.height,
        expiresAt: new Date(now.getTime() + config.PRIVATE_MEDIA_RETENTION_HOURS * 60 * 60_000)
      }
    });
    return { conversation, message: { ...message, deleteUntil: privateMessageDeleteUntil(message.createdAt) }, media: privateMediaDto(media) };
  }).catch(async error => {
    await removePrivateMediaFile(stagingRoot, storageKey);
    throw error;
  });

  try {
    await promotePrivateMediaFile(config.PRIVATE_MEDIA_ROOT, storageKey);
    await prisma.privateMedia.update({ where: { id: created.media.id }, data: { storedAt: new Date() } });
    return created;
  } catch {
    await Promise.all([
      removePrivateMediaFile(stagingRoot, storageKey),
      removePrivateMediaFile(config.PRIVATE_MEDIA_ROOT, storageKey)
    ]);
    const deletedAt = new Date();
    await prisma.$transaction(async tx => {
      await tx.privateMessage.updateMany({ where: { id: created.message.id, deletedAt: null }, data: { deletedAt } });
      await tx.privateMedia.updateMany({ where: { id: created.media.id, purgedAt: null }, data: { deletedAt, purgedAt: deletedAt } });
    });
    throw new PrivateMediaError('STORAGE_FAILURE');
  }
}

export async function deletePrivateMessageForEveryone(messageId: string, userId: string) {
  const deleted = await prisma.$transaction(async tx => {
    const preliminary = await tx.privateMessage.findFirst({
      where: { id: messageId, senderId: userId, deletedAt: null },
      include: { conversation: true, media: true }
    });
    if (!preliminary || preliminary.conversation.status !== 'ACCEPTED') return null;
    await lockPrivatePair(tx, preliminary.conversation.participantOneId, preliminary.conversation.participantTwoId);

    const message = await tx.privateMessage.findFirst({
      where: { id: messageId, senderId: userId, deletedAt: null },
      include: { conversation: true, media: true }
    });
    if (!message || !isParticipant(message.conversation, userId)) return null;
    const blocked = await tx.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: message.conversation.participantOneId, blockedUserId: message.conversation.participantTwoId },
          { blockerId: message.conversation.participantTwoId, blockedUserId: message.conversation.participantOneId }
        ]
      },
      select: { id: true }
    });
    if (blocked || message.conversation.status !== 'ACCEPTED') return null;
    if (Date.now() - message.createdAt.getTime() > config.PRIVATE_MESSAGE_DELETE_WINDOW_MINUTES * 60_000) {
      throw new PrivateMediaError('DELETE_NOT_ALLOWED');
    }
    const deletedAt = new Date();
    await tx.privateMessage.update({ where: { id: message.id }, data: { deletedAt } });
    if (message.media) await tx.privateMedia.update({ where: { id: message.media.id }, data: { deletedAt } });
    await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'PRIVATE_MESSAGE_DELETED',
        targetType: message.media ? 'PrivateMedia' : 'PrivateMessage',
        targetId: message.media?.id ?? message.id,
        metadata: { scope: 'ALL' }
      }
    });
    return {
      storageKey: message.media?.storageKey ?? null,
      mediaId: message.media?.id ?? null,
      conversationId: message.conversation.id,
      participantOneId: message.conversation.participantOneId,
      participantTwoId: message.conversation.participantTwoId
    };
  });
  if (!deleted?.storageKey || !deleted.mediaId) return deleted;

  if (await removePrivateMediaFile(config.PRIVATE_MEDIA_ROOT, deleted.storageKey)) {
    await prisma.privateMedia.updateMany({ where: { id: deleted.mediaId, purgedAt: null }, data: { purgedAt: new Date() } });
  }
  return deleted;
}

export type PrivateMediaCleanupCandidate = { id: string; storageKey: string; expiresAt: Date; deletedAt: Date | null };
export type PrivateMediaCleanupRepository = {
  findPurgeCandidates(now: Date): Promise<PrivateMediaCleanupCandidate[]>;
  markDeleted(id: string, now: Date): Promise<void>;
  markPurged(id: string, now: Date): Promise<void>;
  existingStorageKeys(keys: string[]): Promise<string[]>;
};

const prismaCleanupRepository: PrivateMediaCleanupRepository = {
  findPurgeCandidates: now => prisma.privateMedia.findMany({
    where: { purgedAt: null, OR: [{ expiresAt: { lte: now } }, { deletedAt: { not: null } }] },
    select: { id: true, storageKey: true, expiresAt: true, deletedAt: true },
    orderBy: { createdAt: 'asc' },
    take: 500
  }),
  markDeleted: async (id, now) => { await prisma.privateMedia.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } }); },
  markPurged: async (id, now) => { await prisma.privateMedia.updateMany({ where: { id, purgedAt: null }, data: { purgedAt: now } }); },
  existingStorageKeys: async keys => (await prisma.privateMedia.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } })).map(media => media.storageKey)
};

export async function cleanupPrivateMedia(options: {
  now?: Date;
  mediaRoot?: string;
  repository?: PrivateMediaCleanupRepository;
} = {}) {
  const now = options.now ?? new Date();
  const mediaRoot = options.mediaRoot ?? config.PRIVATE_MEDIA_ROOT;
  const repository = options.repository ?? prismaCleanupRepository;
  let markedDeleted = 0;
  let purged = 0;
  let orphaned = 0;

  for (const media of await repository.findPurgeCandidates(now)) {
    if (!media.deletedAt && media.expiresAt <= now) {
      await repository.markDeleted(media.id, now);
      markedDeleted++;
    }
    if (await removePrivateMediaFile(mediaRoot, media.storageKey)) {
      await repository.markPurged(media.id, now);
      purged++;
    }
  }

  try {
    const keys = (await readdir(resolve(mediaRoot), { withFileTypes: true }))
      .filter(entry => entry.isFile() && storageKeyPattern.test(entry.name))
      .map(entry => entry.name);
    const known = new Set(await repository.existingStorageKeys(keys));
    for (const key of keys) {
      if (!known.has(key) && await removePrivateMediaFile(mediaRoot, key)) orphaned++;
    }
  } catch {
    // A missing/unreadable private root is not an application error and reveals no paths.
  }
  return { markedDeleted, purged, orphaned };
}
