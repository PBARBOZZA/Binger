import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { API_URL, api, deletePrivateMessage, fetchPrivateImage, uploadPrivateImage } from './api';
import { Ban, BellOff, ChevronLeft, Flag, ImageOff, ImagePlus, Lock, LogOut, Menu, MessageCircle, MoreVertical, Send, Settings, ShieldCheck, Trash2, Users, X } from 'lucide-react';

type Profile = { nickname: string; ageRange: string; city: { name: string }; cityId?: string };
type User = { id: string; profile: Profile };
type Participant = { userId: string; nickname: string; ageRange: string };
type PrivateMedia = { id: string; mimeType: string; byteSize: number; width: number; height: number; expiresAt: string };
type ChatMessage = {
  id: string;
  content: string;
  createdAt: string;
  user?: User;
  sender?: User;
  recipient?: User | null;
  scope?: 'PUBLIC' | 'RESERVED';
  blockedForMe?: boolean;
  conversationId?: string;
  kind?: 'TEXT' | 'IMAGE';
  media?: PrivateMedia | null;
};
type Conversation = {
  id: string;
  participantOneId: string;
  participantTwoId: string;
  requestedById: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CLOSED';
  participantOne: User;
  participantTwo: User;
  unreadCount: number;
};
type InviteEvent = { conversation: Conversation; from: User };
type PrivateMediaEvent = { message: ChatMessage; media: PrivateMedia };
type ImageUploadResponse = { message: ChatMessage; media: PrivateMedia };
type SocketAck = { ok?: boolean; error?: string };
type PendingImage = { file: File; url: string };

const color = (id: string) => `hsl(${[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360} 48% 42%)`;
const messageUser = (message: ChatMessage) => message.sender ?? message.user;
const isImageMessage = (message: ChatMessage) => message.kind === 'IMAGE' || Boolean(message.media);
const other = (conversation: Conversation, myId: string) => conversation.participantOneId === myId ? conversation.participantTwo : conversation.participantOne;
const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

function upsertMessage(messages: ChatMessage[], message: ChatMessage) {
  const existing = messages.findIndex(item => item.id === message.id);
  const next = existing === -1 ? [...messages, message] : messages.map(item => item.id === message.id ? { ...item, ...message, media: message.media ?? item.media } : item);
  return next.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
}

function socketAck(socket: Socket, event: string, payload: unknown) {
  return new Promise<SocketAck>(resolve => socket.emit(event, payload, (reply: SocketAck | undefined) => resolve(reply ?? {})));
}

export function Chat() {
  const { roomId, conversationId } = useParams();
  const navigate = useNavigate();
  const [me, setMe] = useState<User | null>(null);
  const [roomMessages, setRoomMessages] = useState<ChatMessage[]>([]);
  const [privateMessages, setPrivateMessages] = useState<ChatMessage[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [privateConversation, setPrivateConversation] = useState<Conversation | null>(null);
  const [reservedFor, setReservedFor] = useState<Participant | null>(null);
  const [menuUser, setMenuUser] = useState<Participant | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [roomsDrawer, setRoomsDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [blocked, setBlocked] = useState<{ id: string; user: User }[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [roomError, setRoomError] = useState('');
  const [privateError, setPrivateError] = useState('');
  const [conversationLoading, setConversationLoading] = useState(false);
  const [transportStatus, setTransportStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [privateJoined, setPrivateJoined] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sendingText, setSendingText] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [inviteActionId, setInviteActionId] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 850px)').matches);
  const [shownBlocked, setShownBlocked] = useState<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const routeConversationRef = useRef<string | undefined>(conversationId);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const menuDialogRef = useRef<HTMLDivElement | null>(null);
  const settingsDialogRef = useRef<HTMLElement | null>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api<Conversation[]>('/private-conversations'));
    } catch (fetchError) {
      setError(errorText(fetchError, 'Não foi possível atualizar as conversas privadas.'));
    }
  }, []);

  const joinPrivateSocket = useCallback(async (id: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setPrivateJoined(false);
      return false;
    }
    const reply = await new Promise<SocketAck>(resolve => socket.emit('private:join', id, (result: SocketAck | undefined) => resolve(result ?? {})));
    if (reply.error) {
      setPrivateJoined(false);
      setPrivateError(reply.error);
      return false;
    }
    setPrivateJoined(true);
    return true;
  }, []);

  useEffect(() => {
    routeConversationRef.current = conversationId;
    if (conversationId) setReservedFor(null);
  }, [conversationId]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 850px)');
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      setInitialLoading(true);
      setRoomError('');
      try {
        const currentUser = await api<User>('/auth/me');
        if (!active) return;
        setMe(currentUser);
        const [messages, listedConversations] = await Promise.allSettled([
          api<ChatMessage[]>(`/rooms/${roomId}/messages`),
          api<Conversation[]>('/private-conversations')
        ]);
        if (!active) return;
        if (messages.status === 'fulfilled') setRoomMessages(messages.value);
        else setRoomError(errorText(messages.reason, 'Não foi possível carregar a conversa geral.'));
        if (listedConversations.status === 'fulfilled') setConversations(listedConversations.value);
        else setError(errorText(listedConversations.reason, 'Não foi possível carregar as conversas privadas.'));
      } catch {
        if (active) navigate('/entrar', { replace: true });
      } finally {
        if (active) setInitialLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [navigate, roomId]);

  useEffect(() => {
    if (!roomId) return;
    const socket = io(API_URL, { withCredentials: true });
    socketRef.current = socket;
    socket.on('connect', () => {
      setTransportStatus('online');
      socket.emit('room:join', roomId, (reply: SocketAck | undefined) => {
        if (reply?.error) setRoomError(reply.error);
      });
      const requestedConversation = routeConversationRef.current;
      if (requestedConversation) void joinPrivateSocket(requestedConversation);
    });
    socket.on('connect_error', () => setTransportStatus('offline'));
    socket.on('disconnect', () => {
      setTransportStatus('offline');
      setPrivateJoined(false);
    });
    socket.on('room:message:new', (message: ChatMessage) => setRoomMessages(current => upsertMessage(current, message)));
    socket.on('room:participants', setPeople);
    socket.on('private:invite', (_invite: InviteEvent) => { void refreshConversations(); });
    socket.on('private:invite:accepted', () => { void refreshConversations(); });
    socket.on('private:invite:rejected', () => { void refreshConversations(); });
    socket.on('private:message:new', (message: ChatMessage) => {
      if (message.conversationId === routeConversationRef.current) setPrivateMessages(current => upsertMessage(current, message));
      void refreshConversations();
    });
    socket.on('private:media:new', (event: PrivateMediaEvent) => {
      const message = { ...event.message, media: event.media };
      if (message.conversationId === routeConversationRef.current) setPrivateMessages(current => upsertMessage(current, message));
      void refreshConversations();
    });
    socket.on('private:message:deleted', (event: { conversationId: string; messageId: string }) => {
      if (event.conversationId === routeConversationRef.current) setPrivateMessages(current => current.filter(message => message.id !== event.messageId));
    });
    return () => {
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [joinPrivateSocket, refreshConversations, roomId]);

  useEffect(() => {
    if (!conversationId) {
      setPrivateConversation(null);
      setPrivateMessages([]);
      setPrivateError('');
      setConversationLoading(false);
      setPrivateJoined(false);
      return;
    }
    const requestedConversationId = conversationId;
    let active = true;
    async function loadPrivateConversation() {
      setConversationLoading(true);
      setPrivateError('');
      setPrivateJoined(false);
      setPrivateMessages([]);
      try {
        const [conversation, messages] = await Promise.all([
          api<Conversation>(`/private-conversations/${encodeURIComponent(requestedConversationId)}`),
          api<ChatMessage[]>(`/private-conversations/${encodeURIComponent(requestedConversationId)}/messages`)
        ]);
        if (!active) return;
        if (conversation.status !== 'ACCEPTED') throw new Error('Esta conversa ainda não está disponível.');
        setPrivateConversation(conversation);
        setPrivateMessages(messages);
        await joinPrivateSocket(conversation.id);
      } catch (fetchError) {
        if (active) {
          setPrivateConversation(null);
          setPrivateError(errorText(fetchError, 'Não foi possível abrir esta conversa privada.'));
        }
      } finally {
        if (active) setConversationLoading(false);
      }
    }
    void loadPrivateConversation();
    return () => { active = false; };
  }, [conversationId, joinPrivateSocket]);

  useEffect(() => () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
  }, [pendingImage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuUser) setMenuUser(null);
      else if (settings) setSettings(false);
      else if (drawer) setDrawer(false);
      else if (roomsDrawer) setRoomsDrawer(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawer, menuUser, roomsDrawer, settings]);

  useEffect(() => {
    if (menuUser) menuDialogRef.current?.focus();
  }, [menuUser]);
  useEffect(() => {
    if (settings) settingsDialogRef.current?.focus();
  }, [settings]);

  const activeConversation = conversationId ? privateConversation : null;
  const recipient = activeConversation && me ? other(activeConversation, me.id) : null;
  const recipientOnline = Boolean(recipient && people.some(person => person.userId === recipient.id));
  const incomingInvites = useMemo(() => me ? conversations.filter(conversation => conversation.status === 'PENDING' && conversation.requestedById !== me.id) : [], [conversations, me]);
  const outgoingInvites = useMemo(() => me ? conversations.filter(conversation => conversation.status === 'PENDING' && conversation.requestedById === me.id) : [], [conversations, me]);
  const acceptedConversations = useMemo(() => conversations.filter(conversation => conversation.status === 'ACCEPTED'), [conversations]);
  const messages = activeConversation ? privateMessages : roomMessages;
  const canSend = transportStatus === 'online' && (!activeConversation || privateJoined) && !conversationLoading && !privateError;
  const privateImageAllowed = Boolean(activeConversation && !conversationLoading && !privateError);
  const privateImageEnabled = privateImageAllowed && canSend;

  function returnToGeneral() {
    if (roomId) navigate(`/sala/${roomId}`);
  }

  function openConversation(conversation: Conversation) {
    if (conversation.status !== 'ACCEPTED' || !roomId) return;
    setRoomsDrawer(false);
    navigate(`/sala/${roomId}/conversas/${conversation.id}`);
  }

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const content = String(new FormData(form).get('message') ?? '').trim();
    if (!content) return;
    if (!canSend) {
      setError(transportStatus !== 'online' ? 'Você está offline. Reconecte-se para enviar uma mensagem.' : 'A conversa privada ainda está sendo preparada.');
      return;
    }
    const socket = socketRef.current;
    if (!socket) {
      setError('Você está offline. Reconecte-se para enviar uma mensagem.');
      return;
    }
    const eventName = activeConversation ? 'private:message' : 'room:message';
    const payload = activeConversation
      ? { conversationId: activeConversation.id, content }
      : { roomId, content, recipientId: reservedFor?.userId };
    setSendingText(true);
    const reply = await socketAck(socket, eventName, payload);
    setSendingText(false);
    if (reply.error) setError(reply.error);
    else form.reset();
  }

  function showImageRestriction() {
    setError('Imagens só podem ser enviadas em conversas privadas.');
  }

  function choosePrivateImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Escolha uma imagem JPEG, PNG ou WebP.');
      return;
    }
    setPendingImage({ file, url: URL.createObjectURL(file) });
    setError('');
  }

  async function sendPrivateImage() {
    if (!activeConversation || !pendingImage) return;
    if (!privateImageEnabled) {
      setError(transportStatus !== 'online' ? 'Você está offline. Reconecte-se para enviar uma imagem.' : 'A conversa privada ainda está sendo preparada.');
      return;
    }
    setUploadingImage(true);
    try {
      const response = await uploadPrivateImage<ImageUploadResponse>(activeConversation.id, pendingImage.file);
      const message: ChatMessage = {
        ...response.message,
        conversationId: response.message.conversationId ?? activeConversation.id,
        sender: response.message.sender ?? me ?? undefined,
        media: response.media
      };
      setPrivateMessages(current => upsertMessage(current, message));
      setPendingImage(null);
      setNotice('Imagem enviada para a conversa privada.');
    } catch (uploadError) {
      setError(errorText(uploadError, 'Não foi possível enviar a imagem.'));
    } finally {
      setUploadingImage(false);
    }
  }

  async function userAction(action: 'reserved' | 'private' | 'mute' | 'block' | 'report', person: Participant) {
    setMenuUser(null);
    if (!me) return;
    if (action === 'reserved') {
      returnToGeneral();
      setReservedFor(person);
      return;
    }
    if (action === 'private') {
      const socket = socketRef.current;
      if (!socket?.connected) {
        setError('Você está offline. Reconecte-se para enviar um convite.');
        return;
      }
      const reply = await socketAck(socket, 'private:invite', { invitedUserId: person.userId });
      if (reply.error) setError(reply.error);
      else {
        setNotice(`Convite enviado para ${person.nickname}.`);
        await refreshConversations();
      }
      return;
    }
    try {
      if (action === 'mute') {
        await api(`/mutes/${person.userId}`, { method: 'POST' });
        setNotice(`${person.nickname} foi silenciado.`);
        return;
      }
      if (action === 'block') {
        if (!window.confirm(`Bloquear ${person.nickname}? Toda interação privada será encerrada.`)) return;
        await api(`/blocks/${person.userId}`, { method: 'POST' });
        if (recipient?.id === person.userId) returnToGeneral();
        setReservedFor(null);
        setNotice(`${person.nickname} foi bloqueado.`);
        await refreshConversations();
        return;
      }
      const reason = window.prompt('Motivo da denúncia:');
      if (reason) {
        await api('/reports', { method: 'POST', body: JSON.stringify({ reportedUserId: person.userId, reason }) });
        setNotice('Denúncia enviada para análise.');
      }
    } catch (actionError) {
      setError(errorText(actionError, 'Não foi possível concluir esta ação.'));
    }
  }

  async function respondToInvite(conversation: Conversation, accept: boolean, block = false) {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError('Você está offline. Reconecte-se para responder ao convite.');
      return;
    }
    setInviteActionId(conversation.id);
    const reply = await socketAck(socket, 'private:invite:respond', { conversationId: conversation.id, accept, block });
    setInviteActionId(null);
    if (reply.error) {
      setError(reply.error);
      return;
    }
    await refreshConversations();
    if (accept && roomId) navigate(`/sala/${roomId}/conversas/${conversation.id}`);
    else setNotice(block ? 'Convite bloqueado.' : 'Convite recusado.');
  }

  async function closeConversation() {
    if (!activeConversation) return;
    if (!window.confirm('Encerrar esta conversa privada?')) return;
    try {
      await api(`/private-conversations/${activeConversation.id}/close`, { method: 'POST' });
      await refreshConversations();
      setNotice('Conversa privada encerrada.');
      returnToGeneral();
    } catch (closeError) {
      setError(errorText(closeError, 'Não foi possível encerrar a conversa.'));
    }
  }

  async function removeForEveryone(message: ChatMessage) {
    if (!activeConversation || messageUser(message)?.id !== me?.id) return;
    if (!window.confirm('Apagar para todos? A mensagem será removida da conversa para os dois participantes.')) return;
    setDeletingMessageId(message.id);
    try {
      await deletePrivateMessage(message.id);
      setPrivateMessages(current => current.filter(item => item.id !== message.id));
      setNotice('Mensagem apagada para todos.');
    } catch (deleteError) {
      setError(errorText(deleteError, 'Não foi possível apagar esta mensagem para todos.'));
    } finally {
      setDeletingMessageId(null);
    }
  }

  async function openSettings() {
    try {
      setBlocked(await api<{ id: string; user: User }[]>('/blocks'));
      setSettings(true);
    } catch (settingsError) {
      setError(errorText(settingsError, 'Não foi possível abrir as configurações.'));
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    navigate('/');
  }

  const displayTitle = activeConversation && recipient ? `Conversa privada com ${recipient.profile.nickname}` : 'Conversa Geral';
  const composerPlaceholder = activeConversation && recipient
    ? `Mensagem privada para ${recipient.profile.nickname}`
    : reservedFor ? `Mensagem reservada para ${reservedFor.nickname}` : 'Escreva uma mensagem…';

  return <main className="chat">
    <aside id="chat-rooms" className={`rooms ${roomsDrawer ? 'open' : ''}`} aria-hidden={isCompact && !roomsDrawer}>
      <div className="mobile-nav-head">
        <Link className="brand" to="/">binger<span>.</span></Link>
        <button className="mobile" type="button" aria-label="Fechar menu de conversas" onClick={() => setRoomsDrawer(false)}><X /></button>
      </div>
      <div className="room-label">SUA CIDADE</div>
      <button type="button" className={`room ${!activeConversation && !conversationId ? 'active' : ''}`} onClick={() => { returnToGeneral(); setRoomsDrawer(false); }}>
        <span>#</span><div><b>Conversa Geral</b><small>{me?.profile.city.name}</small></div>
      </button>

      <div className="room-label private-label">CONVERSAS PRIVADAS</div>
      {incomingInvites.length > 0 && <section className="invite-list" aria-label="Convites recebidos">
        <h2>Convites recebidos</h2>
        {incomingInvites.map(conversation => {
          const person = me ? other(conversation, me.id) : conversation.participantOne;
          const working = inviteActionId === conversation.id;
          return <article key={conversation.id} className="sidebar-invite">
            <Avatar user={person} /><div><b>{person.profile.nickname}</b><small>Quer abrir uma conversa privada</small></div>
            <div className="invite-actions">
              <button type="button" disabled={working} onClick={() => void respondToInvite(conversation, true)}>Aceitar</button>
              <button type="button" disabled={working} onClick={() => void respondToInvite(conversation, false)}>Recusar</button>
              <button type="button" className="danger" disabled={working} onClick={() => void respondToInvite(conversation, false, true)}>Bloquear</button>
            </div>
          </article>;
        })}
      </section>}
      {outgoingInvites.length > 0 && <section className="invite-list" aria-label="Convites enviados">
        <h2>Convites enviados</h2>
        {outgoingInvites.map(conversation => {
          const person = me ? other(conversation, me.id) : conversation.participantOne;
          return <article key={conversation.id} className="sidebar-invite outgoing"><Avatar user={person} /><div><b>{person.profile.nickname}</b><small>Aguardando resposta</small></div></article>;
        })}
      </section>}
      <div className="conversation-list" aria-label="Conversas privadas aceitas">
        {acceptedConversations.map(conversation => {
          const person = me ? other(conversation, me.id) : conversation.participantOne;
          return <button type="button" key={conversation.id} className={`conversation ${activeConversation?.id === conversation.id ? 'active' : ''}`} onClick={() => openConversation(conversation)}>
            <Avatar user={person} /><span><b>{person.profile.nickname}</b><small>Conversa privada</small></span>{conversation.unreadCount > 0 && <em>{conversation.unreadCount}</em>}
          </button>;
        })}
        {!initialLoading && acceptedConversations.length === 0 && <p className="sidebar-empty">Nenhuma conversa privada ainda.</p>}
      </div>
      <div className="privacy-note"><ShieldCheck /><div><b>Você está protegido</b><small>Imagens só podem ser enviadas após os dois aceitarem a conversa.</small></div></div>
      <button className="logout" type="button" onClick={() => void openSettings()}><Settings /> Configurações</button>
      <button className="logout" type="button" onClick={() => void logout()}><LogOut /> Sair da conta</button>
    </aside>

    <section className="messages">
      <header>
        <button className="mobile" type="button" aria-label="Abrir menu de conversas" aria-controls="chat-rooms" aria-expanded={roomsDrawer} onClick={() => setRoomsDrawer(true)}><Menu /></button>
        <div className="conversation-heading">
          {activeConversation && <span className="private-kicker">CONVERSA PRIVADA</span>}
          <h1>{displayTitle}</h1>
          <p>{activeConversation ? <><i className={recipientOnline ? '' : 'offline'} /> {recipientOnline ? 'Online nesta sala' : 'Offline agora'}</> : <><i /> Ao vivo em {me?.profile.city.name}</>}</p>
        </div>
        {activeConversation && <div className="header-actions">
          <button type="button" className="return-general" onClick={returnToGeneral}><ChevronLeft /> Voltar à conversa geral</button>
          <button type="button" onClick={() => void closeConversation()}>Encerrar conversa</button>
          {recipient && <button type="button" className="icon-danger" aria-label={`Bloquear ${recipient.profile.nickname}`} onClick={() => void userAction('block', { userId: recipient.id, nickname: recipient.profile.nickname, ageRange: recipient.profile.ageRange })}><Ban /></button>}
        </div>}
        <button className="mobile" type="button" aria-label="Abrir participantes" aria-controls="chat-participants" aria-expanded={drawer} onClick={() => setDrawer(true)}><Users /><span>{people.length}</span></button>
      </header>

      {!activeConversation && !conversationId && incomingInvites.length > 0 && <section className="invite-banner" aria-label="Convites privados pendentes">
        {incomingInvites.map(conversation => {
          const person = me ? other(conversation, me.id) : conversation.participantOne;
          const working = inviteActionId === conversation.id;
          return <div className="invite-banner-row" key={conversation.id}><span><b>{person.profile.nickname}</b> quer abrir uma conversa privada.</span><button type="button" disabled={working} onClick={() => void respondToInvite(conversation, true)}>Aceitar</button><button type="button" disabled={working} onClick={() => void respondToInvite(conversation, false)}>Recusar</button><button type="button" disabled={working} onClick={() => void respondToInvite(conversation, false, true)}>Bloquear</button></div>;
        })}
      </section>}
      {!activeConversation && !conversationId && <div className="warning"><ShieldCheck /> Não compartilhe telefone, endereço, documentos ou informações financeiras.</div>}
      {activeConversation && <div className="private-safety"><Lock /> Esta é uma conversa privada com {recipient?.profile.nickname}. Só participantes autorizados podem acessar as imagens.</div>}

      <div className="stream" role="log" aria-live="polite" aria-relevant="additions text">
        {initialLoading && !activeConversation && !conversationId && <StateCard title="Carregando a conversa…" detail="Buscando as mensagens e as pessoas na sala." />}
        {!initialLoading && !activeConversation && !conversationId && roomError && <StateCard title="Não foi possível carregar a conversa geral" detail={roomError} actionLabel="Tentar novamente" onAction={() => window.location.reload()} />}
        {conversationId && conversationLoading && <StateCard title="Abrindo conversa privada…" detail="Confirmando o acesso e carregando as mensagens." />}
        {conversationId && !conversationLoading && privateError && <StateCard title="Conversa privada indisponível" detail={privateError} actionLabel="Voltar à conversa geral" onAction={returnToGeneral} />}
        {!initialLoading && !roomError && !conversationId && messages.length === 0 && <StateCard title="A conversa está só começando." detail="Seja gentil e dê o primeiro oi." />}
        {activeConversation && !conversationLoading && !privateError && messages.length === 0 && <StateCard title="Ainda não há mensagens nesta conversa." detail={recipientOnline ? 'A pessoa está online agora.' : 'A pessoa está offline agora; você pode deixar uma mensagem.'} />}
        {(!conversationId || (activeConversation && !privateError)) && messages.map(message => <MessageView key={message.id} message={message} me={me} privateContext={Boolean(activeConversation)} shown={shownBlocked.has(message.id)} deleting={deletingMessageId === message.id} onShow={() => setShownBlocked(current => new Set(current).add(message.id))} onMenu={user => setMenuUser({ userId: user.id, nickname: user.profile.nickname, ageRange: user.profile.ageRange })} onDelete={() => void removeForEveryone(message)} onImageNotice={setNotice} />)}
      </div>

      {transportStatus !== 'online' && <div className="connection-status" role="status">Você está offline. As mensagens e imagens voltarão a ficar disponíveis quando a conexão for restabelecida.</div>}
      {error && <div className="chat-error" role="alert">{error}</div>}
      {notice && <div className="chat-notice" role="status">{notice}</div>}
      {reservedFor && !activeConversation && !conversationId && <div className="reserved-banner"><Lock /> <span>Mensagem reservada para <b>{reservedFor.nickname}</b></span><button type="button" onClick={() => setReservedFor(null)}><X /> Cancelar</button></div>}
      {pendingImage && activeConversation && <div className="image-preview">
        <img src={pendingImage.url} alt="Prévia da imagem selecionada" draggable={false} onContextMenu={event => { event.preventDefault(); setNotice('O menu de contexto foi desativado nesta prévia. Participantes autorizados ainda podem capturar a tela.'); }} />
        <div><b>Imagem pronta para enviar</b><small>Ela será processada pelo servidor e ficará disponível apenas nesta conversa privada. Capturas de tela por participantes autorizados não podem ser impedidas.</small></div>
        <button type="button" aria-label="Remover imagem selecionada" onClick={() => setPendingImage(null)}><Trash2 /></button>
        <button type="button" className="send-image" disabled={uploadingImage || !privateImageEnabled} onClick={() => void sendPrivateImage()}>{uploadingImage ? 'Enviando…' : 'Enviar imagem'}</button>
      </div>}
      <form className="composer" onSubmit={event => void sendText(event)}>
        {privateImageAllowed ? <>
          <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePrivateImage} />
          <button type="button" className="image-button" disabled={!privateImageEnabled} aria-label="Adicionar imagem à conversa privada" onClick={() => fileRef.current?.click()}><ImagePlus /></button>
        </> : <button type="button" className="image-restricted" aria-label="Saiba onde imagens podem ser enviadas" onClick={showImageRestriction}><ImageOff /><span>Imagens</span></button>}
        <label className="sr-only" htmlFor="message">Mensagem</label>
        <input id="message" name="message" maxLength={500} placeholder={composerPlaceholder} autoComplete="off" disabled={!canSend || Boolean(conversationId && !activeConversation)} />
        <button type="submit" aria-label="Enviar mensagem" disabled={!canSend || sendingText || Boolean(conversationId && !activeConversation)}><Send /></button>
      </form>
    </section>

    <aside id="chat-participants" className={`participants ${drawer ? 'open' : ''}`} aria-hidden={isCompact && !drawer}>
      <header><div><b>Na sala agora</b><span>{people.length} participante{people.length === 1 ? '' : 's'}</span></div><button className="mobile" type="button" aria-label="Fechar participantes" onClick={() => setDrawer(false)}><X /></button></header>
      <div className="people">{people.map(person => <button type="button" key={person.userId} className={person.userId === me?.id ? 'self' : ''} onClick={() => person.userId !== me?.id && setMenuUser(person)}><span className="avatar" style={{ background: color(person.userId) }}>{person.nickname.slice(0, 2).toUpperCase()}</span><span><b>{person.nickname}{person.userId === me?.id ? ' (você)' : ''}</b><small>{person.ageRange} · online</small></span></button>)}</div>
      <div className="invite-note">Selecione alguém para enviar uma mensagem reservada ou abrir uma conversa privada. Imagens não são permitidas na conversa geral.</div>
    </aside>

    {menuUser && <div className="user-menu-backdrop" role="presentation" onMouseDown={() => setMenuUser(null)}><div ref={menuDialogRef} className="user-menu" role="dialog" aria-modal="true" aria-label={`Ações para ${menuUser.nickname}`} tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
      <header><Avatar user={{ id: menuUser.userId, profile: { nickname: menuUser.nickname, ageRange: menuUser.ageRange, city: { name: '' } } }} /><div><b>{menuUser.nickname}</b><small>{menuUser.ageRange}</small></div><button type="button" aria-label="Fechar ações" onClick={() => setMenuUser(null)}><X /></button></header>
      <button type="button" onClick={() => void userAction('reserved', menuUser)}><Lock /> Enviar mensagem reservada</button>
      <button type="button" onClick={() => void userAction('private', menuUser)}><MessageCircle /> Abrir conversa privada</button>
      <button type="button" onClick={() => void userAction('mute', menuUser)}><BellOff /> Silenciar</button>
      <button type="button" className="danger" onClick={() => void userAction('block', menuUser)}><Ban /> Bloquear usuário</button>
      <button type="button" onClick={() => void userAction('report', menuUser)}><Flag /> Denunciar usuário</button>
    </div></div>}

    {settings && <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettings(false)}><section ref={settingsDialogRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="blocked-users-title" tabIndex={-1} onMouseDown={event => event.stopPropagation()}><header><h2 id="blocked-users-title">Usuários bloqueados</h2><button type="button" aria-label="Fechar configurações" onClick={() => setSettings(false)}><X /></button></header>{blocked.length === 0 ? <p>Nenhum usuário bloqueado.</p> : blocked.map(item => <div className="blocked-row" key={item.id}><Avatar user={item.user} /><b>{item.user.profile.nickname}</b><button type="button" onClick={async () => { try { await api(`/blocks/${item.user.id}`, { method: 'DELETE' }); setBlocked(current => current.filter(block => block.id !== item.id)); setNotice(`${item.user.profile.nickname} foi desbloqueado.`); } catch (unblockError) { setError(errorText(unblockError, 'Não foi possível desbloquear este usuário.')); } }}>Desbloquear</button></div>)}</section></div>}
  </main>;
}

function StateCard({ title, detail, actionLabel, onAction }: { title: string; detail: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="empty state-card"><h2>{title}</h2><p>{detail}</p>{actionLabel && onAction && <button type="button" onClick={onAction}>{actionLabel}</button>}</div>;
}

function Avatar({ user }: { user: User }) {
  return <div className="avatar" style={{ background: color(user.id) }}>{user.profile.nickname.slice(0, 2).toUpperCase()}</div>;
}

function Meta({ user, date, onMore, onDelete, deleting }: { user: User; date: string; onMore?: () => void; onDelete?: () => void; deleting?: boolean }) {
  return <div className="meta"><b>{user.profile.nickname}</b><span>{user.profile.ageRange}</span><time>{new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time>{onDelete && <button type="button" className="delete-for-everyone" disabled={deleting} onClick={onDelete}><Trash2 /> {deleting ? 'Apagando…' : 'Apagar para todos'}</button>}{onMore && <button type="button" aria-label="Mais ações" onClick={onMore}><MoreVertical /></button>}</div>;
}

function MessageView({ message, me, privateContext, shown, deleting, onShow, onMenu, onDelete, onImageNotice }: { message: ChatMessage; me: User | null; privateContext: boolean; shown: boolean; deleting: boolean; onShow: () => void; onMenu: (user: User) => void; onDelete: () => void; onImageNotice: (notice: string) => void }) {
  const user = messageUser(message);
  if (!user) return null;
  const hidden = message.blockedForMe && !shown;
  const mine = user.id === me?.id;
  const canDelete = privateContext && mine;
  return <article className={mine ? 'mine' : ''}><Avatar user={user} /><div><Meta user={user} date={message.createdAt} onMore={!mine ? () => onMenu(user) : undefined} onDelete={canDelete ? onDelete : undefined} deleting={deleting} />{hidden ? <div className="blocked-message"><span>Mensagem de usuário bloqueado</span><button type="button" onClick={onShow}>Mostrar esta mensagem</button></div> : isImageMessage(message) ? <PrivateImage media={message.media ?? null} senderName={user.profile.nickname} onNotice={onImageNotice} /> : <><p>{message.content}</p>{message.scope === 'RESERVED' && <small className="reserved-label"><Lock /> Reservado para {message.recipient?.profile.nickname ?? 'você'}</small>}</>}</div></article>;
}

function PrivateImage({ media, senderName, onNotice }: { media: PrivateMedia | null; senderName: string; onNotice: (notice: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(media));
  const [unavailable, setUnavailable] = useState(!media);
  useEffect(() => {
    if (!media) return;
    let disposed = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setLoading(true);
    setUnavailable(false);
    void fetchPrivateImage(media.id).then(blob => {
      objectUrl = URL.createObjectURL(blob);
      if (disposed) URL.revokeObjectURL(objectUrl);
      else setSrc(objectUrl);
    }).catch(() => {
      if (!disposed) setUnavailable(true);
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media?.id]);
  if (loading) return <div className="private-image-state">Carregando imagem privada…</div>;
  if (unavailable || !src) return <div className="private-image-state">Imagem indisponível.</div>;
  return <figure className="private-image"><img src={src} alt={`Imagem enviada por ${senderName}`} draggable={false} onDragStart={event => event.preventDefault()} onContextMenu={event => { event.preventDefault(); onNotice('O menu de contexto foi desativado nesta imagem. Participantes autorizados ainda podem capturar a tela.'); }} /><figcaption>Imagem privada. O download não é oferecido; participantes autorizados ainda podem capturar a tela.</figcaption></figure>;
}
