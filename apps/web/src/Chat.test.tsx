// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  disconnect: vi.fn(),
  joinError: ''
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
      if (event === 'room:join') callback(mocks.joinError ? { error: mocks.joinError } : { ok: true, roomId: args[0] });
      else if (event === 'private:join') callback({ ok: true });
      else callback({ ok: true });
    },
    disconnect: mocks.disconnect
  })
}));

const rooms = [
  { id: 'room-1', slug: 'teofilo-otoni-mg', name: 'Conversa Geral', city: 'Teófilo Otoni', state: 'MG', isActive: true },
  { id: 'room-2', slug: 'mucuri-ba', name: 'Conversa Geral', city: 'Mucuri', state: 'BA', isActive: true }
];

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
  mocks.joinError = '';
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
    if (path === '/rooms') return Promise.resolve(rooms);
    if (path === '/auth/me') return Promise.resolve(me);
    if (path === '/rooms/room-1/messages') return Promise.resolve([]);
    if (path === '/private-conversations') return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

afterEach(cleanup);

describe('salas regionais', () => {
  const message = (id: string, roomId: string, content: string) => ({ id, roomId, content, createdAt: '2026-09-05T12:00:00Z', user: other, scope: 'PUBLIC' });
  function regionalApi(history: (path: string) => Promise<unknown>) {
    mocks.api.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve(me);
      if (path === '/rooms') return Promise.resolve(rooms);
      if (path === '/private-conversations') return Promise.resolve([]);
      return history(path);
    });
  }

  it('troca cidade com histórico correto, limpa rascunho e ignora eventos de outra sala', async () => {
    const user = userEvent.setup();
    regionalApi(path => Promise.resolve(path.includes('room-1') ? [message('to', 'room-1', 'Olá Teófilo')] : [message('ba', 'room-2', 'Olá Mucuri')]));
    renderChat('/sala/teofilo-otoni-mg');
    await screen.findByText('Olá Teófilo');
    await user.type(screen.getByRole('textbox', { name: 'Mensagem' }), 'rascunho de TO');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cidade e estado' }), 'room-2');
    expect(await screen.findByRole('heading', { name: 'Mucuri - BA' })).toBeInTheDocument();
    await screen.findByText('Olá Mucuri');
    expect(screen.queryByText('Olá Teófilo')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Mensagem' })).toHaveValue('');
    act(() => mocks.handlers.get('room:message:new')?.(message('leak', 'room-1', 'Mensagem de outra sala')));
    expect(screen.queryByText('Mensagem de outra sala')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Mensagem' }), 'Bom dia BA');
    await user.click(screen.getByRole('button', { name: 'Enviar mensagem' }));
    expect(mocks.emit).toHaveBeenCalledWith('room:message', { roomId: 'room-2', content: 'Bom dia BA', recipientId: undefined }, expect.any(Function));
    expect(screen.getByText(/Você vai publicar em/)).toHaveTextContent('Mucuri - BA');
  });

  it('descarta histórico atrasado da sala anterior e bloqueia envio durante carregamento', async () => {
    let resolveOld!: (messages: unknown[]) => void;
    regionalApi(path => path.includes('room-1') ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve([message('ba', 'room-2', 'Histórico BA')]));
    const user = userEvent.setup(); renderChat();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/rooms/room-1/messages'));
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cidade e estado' }), 'room-2');
    await screen.findByText('Histórico BA');
    await act(async () => resolveOld([message('old', 'room-1', 'Resposta atrasada TO')]));
    expect(screen.queryByText('Resposta atrasada TO')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  });

  it('preserva mensagens recebidas enquanto carrega histórico e sincroniza na reconexão', async () => {
    let resolveHistory!: (messages: unknown[]) => void;
    regionalApi(() => new Promise(resolve => { resolveHistory = resolve; }));
    renderChat();
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/rooms/room-1/messages'));
    const live = message('live', 'room-1', 'Durante histórico');
    act(() => mocks.handlers.get('room:message:new')?.(live));
    await act(async () => resolveHistory([message('old', 'room-1', 'Antiga'), live]));
    expect(screen.getAllByText('Durante histórico')).toHaveLength(1);
    act(() => mocks.handlers.get('disconnect')?.());
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    act(() => mocks.handlers.get('connect')?.());
    await act(async () => resolveHistory([message('missed', 'room-1', 'Recebida offline')]));
    expect(await screen.findByText('Recebida offline')).toBeInTheDocument();
    expect(mocks.api.mock.calls.filter(([path]) => path === '/rooms/room-1/messages')).toHaveLength(2);
  });

  it('não permite envio quando a entrada é recusada ou o histórico falha', async () => {
    mocks.joinError = 'Sala indisponível.';
    renderChat();
    await screen.findByText('Sala indisponível.');
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    expect(mocks.api).not.toHaveBeenCalledWith('/rooms/room-1/messages');
    cleanup(); mocks.joinError = '';
    regionalApi(() => Promise.reject(new Error('Histórico indisponível.')));
    renderChat();
    await screen.findByText('Histórico indisponível.');
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
  });

  it('não redireciona sala desconhecida para outra cidade e oferece seleção', async () => {
    renderChat('/sala/desconhecida');
    await screen.findByText('Esta sala não existe ou está desativada. Escolha outra cidade.');
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    expect(mocks.emit.mock.calls.some(([event]) => event === 'room:join')).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Cidade e estado' })).toBeEnabled();
  });

  it('mantém conversa privada acessível mesmo com sala regional indisponível', async () => {
    const accepted = conversation();
    mocks.api.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve(me);
      if (path === '/rooms') return Promise.resolve(rooms);
      if (path === '/private-conversations') return Promise.resolve([accepted]);
      if (path === '/private-conversations/conversation-1') return Promise.resolve(accepted);
      if (path === '/private-conversations/conversation-1/messages') return Promise.resolve([]);
      return Promise.reject(new Error('Sala indisponível.'));
    });
    renderChat('/sala/desativada/conversas/conversation-1');
    await screen.findByRole('heading', { name: 'Conversa privada com Lua' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adicionar imagem à conversa privada' })).toBeEnabled());
    expect(screen.queryByText(/Você vai publicar em/)).not.toBeInTheDocument();
    expect(mocks.emit.mock.calls.some(([event]) => event === 'room:join')).toBe(false);
  });

  it('oferece seletor no menu mobile e fecha o menu ao trocar cidade', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    regionalApi(() => Promise.resolve([]));
    const user = userEvent.setup(); renderChat();
    await screen.findByRole('heading', { name: 'Teófilo Otoni - MG' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Abrir menu de conversas' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cidade e estado' }), 'room-2');
    await screen.findByRole('heading', { name: 'Mucuri - BA' });
    expect(screen.getByRole('button', { name: 'Abrir menu de conversas' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('experiência de conversa privada', () => {
  it('mantém a sala pública sem seletor de arquivo e explica a restrição de imagem', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByRole('heading', { name: 'Teófilo Otoni - MG' });
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Saiba onde imagens podem ser enviadas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Imagens só podem ser enviadas em conversas privadas.');
  });

  it('hidrata convite pendente e disponibiliza aceitar, recusar e bloquear após recarregar', async () => {
    mocks.api.mockImplementation((path: string) => {
      if (path === '/rooms') return Promise.resolve(rooms);
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
      if (path === '/rooms') return Promise.resolve(rooms);
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
    await screen.findByRole('heading', { name: 'Teófilo Otoni - MG' });
    fireEvent.click(screen.getByRole('button', { name: 'Saiba onde imagens podem ser enviadas' }));
    expect(mocks.emit.mock.calls.some(([event]) => event === 'image:send')).toBe(false);
  });
});
