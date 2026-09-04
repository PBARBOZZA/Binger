// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Chat } from './Chat';

type ConversationFixture = {
  id: string;
  participantOneId: string;
  participantTwoId: string;
  requestedById: string;
  status: 'PENDING' | 'ACCEPTED';
  participantOne: { id: string; profile: { nickname: string; ageRange: string; city: { name: string } } };
  participantTwo: { id: string; profile: { nickname: string; ageRange: string; city: { name: string } } };
  unreadCount: number;
};

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  uploadPrivateImage: vi.fn(),
  fetchPrivateImage: vi.fn(),
  deletePrivateMessage: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn()
}));

vi.mock('./api', () => ({
  API_URL: 'http://api.test',
  api: mocks.api,
  uploadPrivateImage: mocks.uploadPrivateImage,
  fetchPrivateImage: mocks.fetchPrivateImage,
  deletePrivateMessage: mocks.deletePrivateMessage
}));

vi.mock('socket.io-client', () => ({
  io: () => ({
    connected: true,
    on: (event: string, handler: (payload?: unknown) => void) => {
      mocks.handlers.set(event, handler);
      if (event === 'connect') handler();
    },
    emit: (event: string, ...args: unknown[]) => {
      mocks.emit(event, ...args);
      const callback = args.at(-1);
      if (typeof callback !== 'function') return;
      if (event === 'private:join' || event === 'room:join') callback({ ok: true });
      else callback({ ok: true });
    },
    disconnect: mocks.disconnect
  })
}));

const me = { id: 'me', profile: { nickname: 'Eu', ageRange: '25–34', city: { name: 'São Paulo' } } };
const other = { id: 'other', profile: { nickname: 'Lua', ageRange: '25–34', city: { name: 'São Paulo' } } };

function conversation(status: ConversationFixture['status'] = 'ACCEPTED'): ConversationFixture {
  return {
    id: 'conversation-1',
    participantOneId: 'me',
    participantTwoId: 'other',
    requestedById: status === 'PENDING' ? 'other' : 'me',
    status,
    participantOne: me,
    participantTwo: other,
    unreadCount: 0
  };
}

function renderChat(path = '/sala/room-1') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/sala/:roomId" element={<Chat />}/><Route path="/sala/:roomId/conversas/:conversationId" element={<Chat />}/></Routes></MemoryRouter>);
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.uploadPrivateImage.mockReset();
  mocks.fetchPrivateImage.mockReset();
  mocks.deletePrivateMessage.mockReset();
  mocks.handlers.clear();
  mocks.emit.mockReset();
  mocks.disconnect.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  });
  mocks.api.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve(me);
    if (path === '/rooms/room-1/messages') return Promise.resolve([]);
    if (path === '/private-conversations') return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

afterEach(cleanup);

describe('experiência de conversa privada', () => {
  it('mantém a sala pública sem seletor de arquivo e explica a restrição de imagem', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByRole('heading', { name: 'Conversa Geral' });
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Saiba onde imagens podem ser enviadas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Imagens só podem ser enviadas em conversas privadas.');
  });

  it('hidrata convite pendente e disponibiliza aceitar, recusar e bloquear após recarregar', async () => {
    mocks.api.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve(me);
      if (path === '/rooms/room-1/messages') return Promise.resolve([]);
      if (path === '/private-conversations') return Promise.resolve([conversation('PENDING')]);
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    renderChat();
    expect(await screen.findByRole('heading', { name: 'Convites recebidos' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Aceitar' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Recusar' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Bloquear' }).length).toBeGreaterThan(0);
  });

  it('abre rota privada aceita com contexto explícito e controla o upload de imagem', async () => {
    const accepted = conversation();
    mocks.api.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve(me);
      if (path === '/rooms/room-1/messages') return Promise.resolve([]);
      if (path === '/private-conversations') return Promise.resolve([accepted]);
      if (path === '/private-conversations/conversation-1') return Promise.resolve(accepted);
      if (path === '/private-conversations/conversation-1/messages') return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    renderChat('/sala/room-1/conversas/conversation-1');
    expect(await screen.findByRole('heading', { name: 'Conversa privada com Lua' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adicionar imagem à conversa privada' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Voltar à conversa geral/ })).toBeInTheDocument();
  });

  it('não monta payload de imagem pública no Socket', async () => {
    renderChat();
    await screen.findByRole('heading', { name: 'Conversa Geral' });
    fireEvent.click(screen.getByRole('button', { name: 'Saiba onde imagens podem ser enviadas' }));
    expect(mocks.emit.mock.calls.some(([event]) => event === 'image:send')).toBe(false);
  });
});
