import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as client, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/binger_test';
  process.env.SESSION_SECRET = 'regional-test-session-secret-at-least-32-characters';
  process.env.IP_HASH_SECRET = 'regional-test-ip-secret';
  return {
    session: { findUnique: vi.fn() }, room: { findFirst: vi.fn(), findMany: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() }, userBlock: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(), privateConversation: { findFirst: vi.fn(), create: vi.fn() },
    roomMessage: { create: vi.fn(), findMany: vi.fn() }
  };
});
vi.mock('./db.js', () => ({ prisma: db }));
import { app } from './app.js';
import { configureSocket } from './socket.js';
import { hash } from './security.js';

const rooms = [
  { id: 'old-to-id', publicSlug: 'teofilo-otoni-mg', name: 'Conversa Geral', active: true, city: { id: 'to', name: 'Teófilo Otoni', state: 'MG', active: true } },
  { id: 'mucuri-id', publicSlug: 'mucuri-ba', name: 'Conversa Geral', active: true, city: { id: 'mucuri', name: 'Mucuri', state: 'BA', active: true } }
];
let server: HttpServer;
let io: Server;
let url: string;
let sockets: Socket[];
let sessions: Map<string, any>;
let saved: any[];
let position: bigint;

beforeEach(async () => {
  vi.clearAllMocks();
  rooms.forEach(room => { room.active = true; room.city.active = true; });
  sessions = new Map(); saved = []; sockets = []; position = 0n;
  db.$queryRaw.mockImplementation(async () => [{ after: ++position, joinedAt: new Date() }]);
  for (const id of ['a', 'b', 'c']) sessions.set(id, { id, userId: id, expiresAt: new Date(Date.now() + 60_000), revokedAt: null, user: { id, status: 'ACTIVE', profile: { cityId: 'to', nickname: id, ageRange: '25–34' } } });
  db.session.findUnique.mockImplementation(async ({ where }) => where.id ? sessions.get(where.id) : [...sessions.values()].find(session => hash(session.id) === where.tokenHash));
  db.room.findFirst.mockImplementation(async ({ where }) => rooms.find(room => room.active && room.city.active && where.active === true && where.city.active === true && where.OR.some((filter: any) => filter.id === room.id || filter.publicSlug === room.publicSlug)) ?? null);
  db.room.findMany.mockImplementation(async () => rooms.filter(room => room.active && room.city.active));
  db.userBlock.findMany.mockResolvedValue([]);
  db.userBlock.findFirst.mockResolvedValue(null);
  db.user.findFirst.mockImplementation(async ({ where }) => sessions.get(where.id)?.user);
  db.user.findUnique.mockImplementation(async ({ where }) => sessions.get(where.id)?.user);
  db.$transaction.mockImplementation(async callback => callback(db));
  db.$executeRaw.mockResolvedValue(1);
  db.privateConversation.findFirst.mockResolvedValue(null);
  db.privateConversation.create.mockImplementation(async ({ data }) => ({ ...data, id: 'invitation', status: 'PENDING' }));
  db.roomMessage.create.mockImplementation(async ({ data }) => {
    const message = { ...data, id: `message-${saved.length}`, position: ++position, createdAt: new Date(), deletedAt: null, moderationStatus: 'VISIBLE' };
    saved.push(message); return message;
  });
  db.roomMessage.findMany.mockImplementation(async ({ where }) => saved.filter(message => message.position > where.position.gt && message.roomId === where.roomId && message.deletedAt === null && message.moderationStatus === where.moderationStatus && where.OR.some((filter: any) => filter.scope === message.scope || filter.userId === message.userId || filter.recipientId === message.recipientId)));
  server = createServer(app); io = new Server(server); configureSocket(io);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  sockets.forEach(socket => socket.disconnect());
  await new Promise<void>(resolve => io.close(() => resolve()));
});

async function connect(id: string) {
  const socket = client(url, { transports: ['websocket'], extraHeaders: { cookie: `binger_session=${id}` }, reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
const ack = (socket: Socket, event: string, payload: unknown) => socket.timeout(2000).emitWithAck(event, payload);
async function get(path: string, user = 'a', participationId = '') {
  return fetch(`${url}/api${path}`, { headers: { cookie: `binger_session=${user}`, 'X-Room-Participation': participationId } });
}
// An acknowledged round trip drains earlier frames, avoiding timing-based sleeps.
const drain = (socket: Socket, room: string) => ack(socket, 'room:join', room);

describe('salas regionais — HTTP e Socket.IO reais com repositório isolado', () => {
  it('impede que recém-chegados obtenham públicas e reservadas anteriores, inclusive de quem saiu', async () => {
    const a = await connect('a'), oldC = await connect('c');
    await ack(a, 'room:join', 'old-to-id');
    const oldVisit = await ack(oldC, 'room:join', 'old-to-id');
    await ack(a, 'room:message', { roomId: 'old-to-id', content: 'pública anterior' });
    await ack(a, 'room:message', { roomId: 'old-to-id', recipientId: 'c', content: 'reservada anterior' });
    await ack(oldC, 'room:leave', null);
    expect((await get('/rooms/old-to-id/messages', 'c', oldVisit.participationId)).status).toBe(403);
    const c = await connect('c');
    const received = vi.fn(); c.on('room:message:new', received);
    const visit = await ack(c, 'room:join', 'old-to-id');
    const read = () => get('/rooms/old-to-id/messages?after=0&joinedAt=1970-01-01', 'c', visit.participationId);
    expect(await (await read()).json()).toEqual([]);
    expect(received).not.toHaveBeenCalled();
    await ack(a, 'room:message', { roomId: 'old-to-id', content: 'pública durante presença' });
    await ack(a, 'room:message', { roomId: 'old-to-id', recipientId: 'c', content: 'reservada durante presença' });
    await ack(a, 'room:leave', null);
    // HTTP round trip follows committed writes; sender presence is not a history filter.
    const messages = await (await read()).json();
    expect(messages.map((m: any) => m.content)).toEqual(['pública durante presença', 'reservada durante presença']);
    expect(received.mock.calls.map(([m]) => m.content)).toEqual(['pública durante presença', 'reservada durante presença']);
    expect(messages.every((m: any) => m.participationId === visit.participationId && !('position' in m))).toBe(true);
    saved[2].deletedAt = new Date(); saved[3].moderationStatus = 'HIDDEN';
    expect(await (await read()).json()).toEqual([]);
    expect(saved).toHaveLength(4);
  });

  it('isola ingresso por aba e sessão; troca, saída e reconexão invalidam a janela anterior', async () => {
    const a = await connect('a'), b = await connect('b');
    const first = await ack(a, 'room:join', 'old-to-id');
    await ack(b, 'room:join', 'old-to-id');
    await ack(b, 'room:message', { roomId: 'old-to-id', content: 'só a primeira aba estava presente' });
    const secondTab = await connect('a');
    const second = await ack(secondTab, 'room:join', 'old-to-id');
    expect(second.participationId).not.toBe(first.participationId);
    expect(await (await get('/rooms/old-to-id/messages', 'a', second.participationId)).json()).toEqual([]);
    expect(await (await get('/rooms/old-to-id/messages', 'a', first.participationId)).json()).toHaveLength(1);
    expect((await get('/rooms/old-to-id/messages', 'b', first.participationId)).status).toBe(403);
    sessions.set('another-a-session', { ...sessions.get('a'), id: 'another-a-session' });
    expect((await get('/rooms/old-to-id/messages', 'another-a-session', first.participationId)).status).toBe(403);
    expect((await get('/rooms/old-to-id/messages', 'a', 'forged')).status).toBe(403);
    await ack(a, 'room:join', 'mucuri-ba');
    expect((await get('/rooms/old-to-id/messages', 'a', first.participationId)).status).toBe(403);
    const back = await ack(a, 'room:join', 'old-to-id');
    expect(await (await get('/rooms/old-to-id/messages', 'a', back.participationId)).json()).toEqual([]);
    const serverSocket = io.sockets.sockets.get(a.id!)!;
    const disconnected = new Promise<void>(resolve => serverSocket.once('disconnect', () => resolve()));
    a.disconnect(); await disconnected;
    expect((await get('/rooms/old-to-id/messages', 'a', back.participationId)).status).toBe(403);
    const reconnected = await connect('a');
    const fresh = await ack(reconnected, 'room:join', 'old-to-id');
    expect(fresh.participationId).not.toBe(back.participationId);
    expect(await (await get('/rooms/old-to-id/messages', 'a', fresh.participationId)).json()).toEqual([]);
    // A sibling tab's participation remains valid after another tab leaves.
    expect((await get('/rooms/old-to-id/messages', 'a', second.participationId)).status).toBe(200);
  });

  it.each(['PUBLIC', 'RESERVED'])('não emite %s antiga cuja entrega terminou depois do novo ingresso, mesmo com timestamp futuro', async scope => {
    const a = await connect('a'), b = await connect('b');
    await ack(a, 'room:join', 'old-to-id');
    await ack(b, 'room:join', 'old-to-id');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const create = db.roomMessage.create.getMockImplementation()!;
    db.roomMessage.create.mockImplementationOnce(async args => {
      const message = await create(args);
      message.createdAt = new Date('2099-01-01');
      started(); await new Promise<void>(resolve => { release = resolve; });
      return message;
    });
    const send = ack(a, 'room:message', { roomId: 'old-to-id', content: 'entrega atrasada', ...(scope === 'RESERVED' ? { recipientId: 'b' } : {}) });
    await pending;
    const received = vi.fn(); b.on('room:message:new', received);
    const visit = await ack(b, 'room:join', 'old-to-id');
    release(); await send;
    expect(await (await get('/rooms/old-to-id/messages', 'b', visit.participationId)).json()).toEqual([]);
    expect(received).not.toHaveBeenCalled();
  });

  it('recupera todas as mensagens entre o registro do ingresso e a assinatura Socket.IO', async () => {
    const b = await connect('b');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    db.$queryRaw.mockImplementationOnce(async () => {
      const boundary = { after: ++position, joinedAt: new Date() };
      started(); await new Promise<void>(resolve => { release = resolve; });
      return [boundary];
    });
    const join = ack(b, 'room:join', 'old-to-id');
    await pending;
    for (let i = 0; i < 60; i++) await db.roomMessage.create({ data: { roomId: 'old-to-id', userId: 'a', scope: 'PUBLIC', content: `durante ingresso ${i}` } });
    release();
    const visit = await join;
    const response = await get('/rooms/old-to-id/messages', 'b', visit.participationId);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const messages = await response.json();
    expect(messages).toHaveLength(60);
    expect(new Set(messages.map((m: any) => m.id)).size).toBe(60);
  });

  it('recusa resposta HTTP em voo quando a participação foi encerrada durante a consulta', async () => {
    const a = await connect('a');
    const visit = await ack(a, 'room:join', 'old-to-id');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    db.roomMessage.findMany.mockImplementationOnce(async () => {
      started(); await new Promise<void>(resolve => { release = resolve; }); return [];
    });
    const response = get('/rooms/old-to-id/messages', 'a', visit.participationId);
    await pending;
    await ack(a, 'room:leave', null);
    release();
    expect((await response).status).toBe(403);
  });

  it('recusa histórico sem ingresso e datas forjadas; resolve o endereço pelo ID original', async () => {
    expect((await fetch(`${url}/api/rooms`)).status).toBe(401);
    const catalog = await (await get('/rooms')).json();
    expect(catalog.map((room: any) => room.id)).toEqual(['old-to-id', 'mucuri-id']);
    expect(catalog[0].slug).toBe('teofilo-otoni-mg');
    for (const reference of ['old-to-id', 'teofilo-otoni-mg']) {
      expect((await get(`/rooms/${reference}/messages?joinedAt=1970-01-01&after=0`)).status).toBe(403);
    }
    const a = await connect('a');
    expect(await ack(a, 'room:join', { roomId: 'old-to-id', joinedAt: '1970-01-01' })).toHaveProperty('error');
    const joined = await ack(a, 'room:join', 'teofilo-otoni-mg');
    expect(joined).toMatchObject({ ok: true, roomId: 'old-to-id', participationId: expect.any(String), joinedAt: expect.any(String) });
    for (const reference of ['old-to-id', 'teofilo-otoni-mg']) expect(await (await get(`/rooms/${reference}/messages`, 'a', joined.participationId)).json()).toEqual([]);
    expect((await get('/rooms/mucuri-ba/messages', 'a', joined.participationId)).status).toBe(403);
    expect((await get('/rooms/unknown/messages')).status).toBe(404);
    rooms[1]!.city.active = false;
    expect((await get('/rooms/mucuri-ba/messages')).status).toBe(404);
  });

  it('entrega mensagens apenas à sala escolhida e impede enviar para sala não ingressada', async () => {
    const a = await connect('a'), b = await connect('b'), c = await connect('c');
    await ack(a, 'room:join', 'teofilo-otoni-mg');
    await ack(b, 'room:join', 'old-to-id');
    await ack(c, 'room:join', 'mucuri-ba');
    const bMessages = vi.fn(), cMessages = vi.fn();
    b.on('room:message:new', bMessages); c.on('room:message:new', cMessages);
    expect(await ack(a, 'room:message', { roomId: 'mucuri-id', content: 'wrong-room' })).toHaveProperty('error');
    expect(await ack(a, 'room:message', { roomId: 'teofilo-otoni-mg', content: 'oi TO' })).toMatchObject({ ok: true });
    await drain(b, 'old-to-id'); await drain(c, 'mucuri-id');
    expect(bMessages).toHaveBeenCalledOnce(); expect(cMessages).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1); expect(saved[0].roomId).toBe('old-to-id');
  });

  it('serializa trocas concorrentes, limpa presença e deixa somente a última sala', async () => {
    const a = await connect('a'), b = await connect('b');
    await ack(b, 'room:join', 'old-to-id');
    const presence = vi.fn(); b.on('room:presence', presence);
    await Promise.all([ack(a, 'room:join', 'old-to-id'), ack(a, 'room:join', 'mucuri-ba')]);
    await drain(b, 'old-to-id');
    expect(presence.mock.calls.at(-1)?.[0]).toMatchObject({ roomId: 'old-to-id', participants: [{ userId: 'b' }] });
    expect([...io.sockets.sockets.get(a.id!)!.rooms].filter(name => name.startsWith('room:'))).toEqual(['room:mucuri-id']);
    expect(await ack(a, 'room:message', { roomId: 'old-to-id', content: 'stale' })).toHaveProperty('error');
    expect(await ack(a, 'room:message', { roomId: 'mucuri-id', content: 'nova sala' })).toMatchObject({ ok: true });
  });

  it('limita reservadas à sala e aos dois usuários, inclusive em múltiplas abas', async () => {
    const a = await connect('a'), b = await connect('b'), bElsewhere = await connect('b'), c = await connect('c');
    for (const socket of [a, b, c]) await ack(socket, 'room:join', 'old-to-id');
    await ack(bElsewhere, 'room:join', 'mucuri-ba');
    const received = vi.fn(), elsewhere = vi.fn(), thirdParty = vi.fn();
    b.on('room:message:new', received); bElsewhere.on('room:message:new', elsewhere); c.on('room:message:new', thirdParty);
    expect(await ack(a, 'room:message', { roomId: 'old-to-id', recipientId: 'b', content: 'reservada' })).toMatchObject({ ok: true });
    await drain(b, 'old-to-id'); await drain(bElsewhere, 'mucuri-ba'); await drain(c, 'old-to-id');
    expect(received).toHaveBeenCalledOnce(); expect(elsewhere).not.toHaveBeenCalled(); expect(thirdParty).not.toHaveBeenCalled();
    await ack(b, 'room:join', 'mucuri-ba');
    expect(await ack(a, 'room:message', { roomId: 'old-to-id', recipientId: 'b', content: 'ausente' })).toHaveProperty('error');
  });

  it('revalida sala/cidade/sessão e rejeita imagem ou campos extras sem gravar mensagem', async () => {
    const a = await connect('a');
    await ack(a, 'room:join', 'old-to-id');
    for (const extra of [{ kind: 'IMAGE' }, { image: 'data:image/png;base64,abc' }, { mediaId: 'private-id' }]) {
      expect(await ack(a, 'room:message', { roomId: 'old-to-id', content: 'foto', ...extra })).toHaveProperty('error');
    }
    rooms[0]!.active = false;
    expect(await ack(a, 'room:message', { roomId: 'old-to-id', content: 'disabled' })).toHaveProperty('error');
    expect(await ack(a, 'room:join', 'old-to-id')).toHaveProperty('error');
    rooms[0]!.active = true; rooms[0]!.city.active = false;
    expect(await ack(a, 'room:join', 'old-to-id')).toHaveProperty('error');
    rooms[0]!.city.active = true;
    await ack(a, 'room:join', 'old-to-id');
    sessions.get('a').revokedAt = new Date();
    expect(await ack(a, 'room:message', { roomId: 'old-to-id', content: 'revoked' })).toHaveProperty('error');
    expect(db.roomMessage.create).not.toHaveBeenCalled();
  });

  it('permite convite entre visitantes da mesma sala com consentimento e bloqueios preservados', async () => {
    sessions.get('b').user.profile.cityId = 'mucuri';
    const a = await connect('a'), b = await connect('b');
    await ack(a, 'room:join', 'old-to-id'); await ack(b, 'room:join', 'mucuri-id');
    expect(await ack(a, 'private:invite', { invitedUserId: 'b' })).toHaveProperty('error');
    await ack(a, 'room:join', 'mucuri-id');
    sessions.get('b').user.profile.invitationPreference = 'NONE';
    expect(await ack(a, 'private:invite', { invitedUserId: 'b' })).toHaveProperty('error');
    sessions.get('b').user.profile.invitationPreference = 'ALL';
    db.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    expect(await ack(a, 'private:invite', { invitedUserId: 'b' })).toHaveProperty('error');
    db.userBlock.findFirst.mockResolvedValue(null);
    expect(await ack(a, 'private:invite', { invitedUserId: 'b' })).toMatchObject({ ok: true, status: 'PENDING' });
    expect(db.privateConversation.create).toHaveBeenCalledOnce();
  });
});
