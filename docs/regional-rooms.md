# Salas regionais

## Modelo e preservação dos dados

O schema original já contém `City`, `Room` e a FK obrigatória `RoomMessage.roomId`, com índice por sala/data. `Room` cumpre o papel de `ChatRoom`; criar outra tabela ou mover mensagens duplicaria esse domínio. Cidade/estado e ativação permanecem normalizados em `City` e `Room`.

A migration `20260905120000_regional_rooms` adiciona apenas `Room.publicSlug` (único, opcional para registros legados) e `Room.updatedAt`. Ela cadastra as cidades/salas ausentes e atribui `teofilo-otoni-mg` e `mucuri-ba` às respectivas salas `conversa-geral`, preservando IDs, slugs locais e flags de ativação.

As mensagens antigas continuam ligadas ao mesmo ID de sala de Teófilo Otoni. Mensagens que já estejam em Mucuri ou em outras salas mantêm seus vínculos. Nenhum `RoomMessage`, perfil, conversa ou registro de mídia privada é atualizado ou apagado. Os testes de migração verificam os registros completos antes/depois em PostgreSQL isolado via PGlite, além de instalação vazia, FK e unicidade.

O SQL roda em transação com limite de espera de lock de 10 segundos. Uma cidade com slug esperado e estado diferente causa erro e rollback integral, exigindo inspeção dos dados antes de nova tentativa. O seed pode ser repetido para completar o cadastro sem reativar cidades ou salas desativadas.

## Contratos e isolamento

- `GET /api/rooms`: catálogo autenticado de salas com cidade e sala ativas. Retorna `id`, `slug`, `name`, `cityId`, `city`, `state`, `isActive`, `createdAt`, `updatedAt`.
- `GET /api/rooms/:idOuSlug`: metadados da sala ativa.
- `GET /api/rooms/:idOuSlug/messages`: últimas 50 mensagens visíveis daquela sala; exige sessão ativa e perfil. Reservadas só são retornadas ao autor/destinatário. Mantém o indicador de bloqueio existente.
- `room:join(idOuSlug, ack)`: exige sala explícita; sai da anterior e remove presença. Retorna `{ ok: true, roomId }` ou erro, sem fallback para outra cidade.
- `room:message({ roomId, content, recipientId? }, ack)`: `roomId` aceita ID/slug; valida novamente sala/cidade ativas, sessão, vínculo atual, texto, limite e bloqueios. Campos de imagem ou outros extras são recusados.
- `room:message:new`: contém `roomId`; mensagens públicas só chegam aos sockets daquela sala. Reservadas chegam apenas aos dois usuários conectados naquela sala, inclusive no caso de múltiplas abas.
- `room:presence`: `{ roomId, participants }` permite ignorar eventos de outra sala. O evento legado `room:participants` continua enviando um array para compatibilidade de clientes durante a atualização.

Entradas/envios são serializados por socket. Mudar de sala não altera a cidade do perfil. Convites privados entre cidades de perfil diferentes exigem presença conjunta em uma sala ativa; consentimento, preferências e bloqueios continuam obrigatórios. A política anterior de convites na mesma cidade de perfil continua válida. Acesso e armazenamento de mídia privada não foram modificados.

A interface mostra cidade/UF no cabeçalho, seletor, participantes e destino do envio público. Ao trocar de sala, limpa histórico, destinatário reservado, presença e rascunho público; só habilita envio após confirmação de entrada e histórico. Descarta respostas/eventos antigos, combina histórico com mensagens recebidas durante o carregamento e sincroniza após reconexão. Conversas privadas já aceitas permanecem acessíveis mesmo se a sala regional da URL estiver indisponível.

## Aplicação em ambiente real

1. Faça backup e ensaie a restauração/cópia do banco de destino. Confira `City` e `Room`, em especial os slugs locais `teofilo-otoni`, `mucuri` e `conversa-geral`, e conte mensagens por `roomId` antes/depois.
2. Com o `DATABASE_URL` do ambiente correto, aplique `npm run db:deploy --workspace @binger/api` antes de publicar a nova API. A migration já cadastra as duas salas; o seed não é necessário para esse deploy.
3. Publique API e frontend da mesma revisão e recarregue clientes. URLs antigas por ID continuam válidas. Em seguida, confira as duas salas com contas/abas distintas.
4. Se necessário, reverta somente a aplicação. Mantenha as colunas aditivas e o cadastro; não apague salas, mensagens ou colunas para reverter a versão. Se a migration falhar por lock/identidade inesperada, inspecione o banco e o estado de migrations antes de usar os comandos de resolução do Prisma.

O ensaio automatizado não acessa o `DATABASE_URL` configurado e não substitui a conferência de dados e de concorrência no PostgreSQL de destino. Presença, emissões e limites continuam locais a uma instância da API, como na arquitetura existente; múltiplas instâncias requerem adapter e estado distribuídos. Histórico continua limitado a 50 mensagens, sem paginação adicional.

Para adicionar uma cidade, cadastre `City` e sua `Room`, atribuindo um `publicSlug` único no formato `cidade-uf`. Salas legadas sem `publicSlug` continuam acessíveis pelo ID.

## Validação

```sh
npm run test --workspace @binger/api
npm run test --workspace @binger/web
npm run build --workspace @binger/api
npm run build --workspace @binger/web
npx prisma validate --schema apps/api/prisma/schema.prisma
```

`rooms.test.ts` usa HTTP e clientes Socket.IO reais com repositório isolado. `rooms-migration.test.ts` aplica todos os SQLs em PGlite e verifica preservação/rollback. Os testes da tela cobrem troca de sala, respostas atrasadas, isolamento de eventos, reconexão, erros, navegação mobile e continuidade do privado.
