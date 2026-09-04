import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/binger_test';
  process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-thirty-two-characters';
  process.env.IP_HASH_SECRET ??= 'test-ip-hash-secret';
});

import {
  PUBLIC_IMAGE_REJECTION_MESSAGE,
  PRIVATE_MEDIA_RATE_WINDOW_MS,
  PrivateMediaError,
  PrivateMediaRateLimiter,
  canReadPrivateMedia,
  cleanupPrivateMedia,
  createPrivateMediaStorageKey,
  detectPrivateImageMime,
  normalizePrivateImage,
  privateMediaPath
} from './private-media.js';

const limits = { maxBytes: 262_144, maxWidth: 1600, maxHeight: 1600, maxPixels: 2_560_000 };
const mediaKey = 'a'.repeat(64) + '.webp';
const orphanKey = 'b'.repeat(64) + '.webp';

async function sharpFactory() {
  return (await import('sharp')).default as any;
}

describe('mídia privada', () => {
  it('rejeita SVG, HTML e formatos sem assinatura permitida', async () => {
    expect(detectPrivateImageMime(Buffer.from('<svg><script>alert(1)</script></svg>'))).toBeNull();
    expect(detectPrivateImageMime(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    await expect(normalizePrivateImage(Buffer.from('<svg/>'), limits)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('rejeita conteúdo disfarçado por Content-Type e dimensão acima do limite', async () => {
    const sharp = await sharpFactory();
    const oversizedDimensions = await sharp({ create: { width: 81, height: 20, channels: 3, background: '#000' } }).png().toBuffer();
    await expect(normalizePrivateImage(Buffer.from('not-an-image'), limits)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(normalizePrivateImage(oversizedDimensions, { ...limits, maxWidth: 80 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('reprocessa JPEG permitido e remove metadados EXIF', async () => {
    const sharp = await sharpFactory();
    const jpegWithExif = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#9b265b' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Artist: 'private-person' } } })
      .toBuffer();

    const normalized = await normalizePrivateImage(jpegWithExif, limits);
    const metadata = await sharp(normalized.bytes).metadata();
    expect(normalized.mimeType).toBe('image/webp');
    expect(normalized.width).toBe(24);
    expect(normalized.height).toBe(16);
    expect(metadata.exif).toBeUndefined();
  });

  it('usa chaves opacas e impede traversal do diretório privado', () => {
    const key = createPrivateMediaStorageKey();
    expect(key).toMatch(/^[a-f0-9]{64}\.webp$/);
    expect(() => privateMediaPath(join(tmpdir(), 'binger-media-test'), '../outside.webp')).toThrow(PrivateMediaError);
  });

  it('aplica limites independentes por usuário, conversa e IP', () => {
    const limiter = new PrivateMediaRateLimiter();
    const first = { userId: 'user-a', conversationId: 'conversation-a', ipKey: 'ip-a' };
    expect(limiter.consume(first, { user: 1, conversation: 2, ip: 2 }, 0)).toBe(true);
    expect(limiter.consume(first, { user: 1, conversation: 2, ip: 2 }, 1)).toBe(false);
    expect(limiter.consume({ ...first, userId: 'user-b' }, { user: 1, conversation: 2, ip: 2 }, 2)).toBe(true);
    expect(limiter.consume({ ...first, userId: 'user-c' }, { user: 1, conversation: 2, ip: 2 }, PRIVATE_MEDIA_RATE_WINDOW_MS + 1)).toBe(true);
  });

  it('não autoriza leitura para terceiro, bloqueio ou mídia excluída', () => {
    const base = {
      userId: 'a',
      blocked: false,
      conversation: { participantOneId: 'a', participantTwoId: 'b', status: 'ACCEPTED' },
      message: { kind: 'IMAGE', deletedAt: null, moderationStatus: 'VISIBLE' },
      media: { storedAt: new Date(), deletedAt: null, purgedAt: null, expiresAt: new Date(Date.now() + 60_000) }
    };
    expect(canReadPrivateMedia(base)).toBe(true);
    expect(canReadPrivateMedia({ ...base, userId: 'c' })).toBe(false);
    expect(canReadPrivateMedia({ ...base, blocked: true })).toBe(false);
    expect(canReadPrivateMedia({ ...base, media: { ...base.media, deletedAt: new Date() } })).toBe(false);
  });

  it('remove mídia expirada e arquivos órfãos sem sair do diretório privado', async () => {
    const root = await mkdtemp(join(tmpdir(), 'binger-private-media-'));
    const deleted: string[] = [];
    const purged: string[] = [];
    try {
      await writeFile(join(root, mediaKey), 'expired');
      await writeFile(join(root, orphanKey), 'orphan');
      const result = await cleanupPrivateMedia({
        now: new Date('2026-09-04T12:00:00.000Z'),
        mediaRoot: root,
        repository: {
          findPurgeCandidates: async () => [{ id: 'media-1', storageKey: mediaKey, expiresAt: new Date('2026-09-04T11:00:00.000Z'), deletedAt: null }],
          markDeleted: async id => { deleted.push(id); },
          markPurged: async id => { purged.push(id); },
          existingStorageKeys: async () => []
        }
      });
      expect(result).toEqual({ markedDeleted: 1, purged: 1, orphaned: 1 });
      expect(deleted).toEqual(['media-1']);
      expect(purged).toEqual(['media-1']);
      await expect(readFile(join(root, mediaKey))).rejects.toThrow();
      await expect(readFile(join(root, orphanKey))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mantém a rejeição pública explícita e sem upload alternativo', () => {
    expect(PUBLIC_IMAGE_REJECTION_MESSAGE).toBe('Imagens só podem ser enviadas em conversas privadas.');
  });
});
