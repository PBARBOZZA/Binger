import { describe, expect, it } from 'vitest';
import { allowedImageType, canonicalPair, canSeeRoomMessage, isParticipant } from './privacy.js';

describe('privacy boundaries with users A, B and C', () => {
  it('delivers public messages to all and reserved messages only to A and B', () => {
    const publicMessage = { userId: 'A', recipientId: null, scope: 'PUBLIC' as const };
    const reserved = { userId: 'A', recipientId: 'B', scope: 'RESERVED' as const };
    expect(['A', 'B', 'C'].map(id => canSeeRoomMessage(publicMessage, id))).toEqual([true, true, true]);
    expect(['A', 'B', 'C'].map(id => canSeeRoomMessage(reserved, id))).toEqual([true, true, false]);
  });
  it('canonicalizes pairs and rejects a third participant', () => {
    expect(canonicalPair('B', 'A')).toEqual(['A', 'B']);
    const conversation = { participantOneId: 'A', participantTwoId: 'B' };
    expect(isParticipant(conversation, 'A')).toBe(true);
    expect(isParticipant(conversation, 'B')).toBe(true);
    expect(isParticipant(conversation, 'C')).toBe(false);
  });
  it('accepts only real JPEG, PNG and WebP signatures', () => {
    expect(allowedImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xd9]))).toBe('image/jpeg');
    expect(allowedImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0, 0]))).toBeNull();
    expect(allowedImageType(Uint8Array.from([0x3c, 0x73, 0x76, 0x67]))).toBeNull();
    expect(allowedImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});
