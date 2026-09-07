# Salas regionais e privacidade por ingresso

## Correção do ensaio de Teófilo Otoni

A migration aplicada `20260905120000_regional_rooms` permanece intacta. Ela reconhecia somente `conversa-geral`; no ensaio com `Sala Geral` / `geral`, criou uma segunda sala e atribuiu o endereço à sala vazia.

A migration adicional `20260907120000_repair_regional_rooms` preserva o ID, o nome, o slug `geral`, a ativação e todas as mensagens da sala original, atribuindo-lhe `publicSlug = teofilo-otoni-mg`. Ela libera o endereço da duplicata e a desativa, sem excluir a sala nem mover mensagens. O mesmo reconhecimento de legado é aplicado a Mucuri, quando houver `Sala Geral` / `geral`.

A desativação automática exige todas estas condições:

- Sala original com slug `geral`, nome `Sala Geral` e endereço ausente ou já correto.
- Duplicata com o ID determinístico da migration anterior (`cregionalroomteofilootoni` em Teófilo Otoni), mesma cidade, nome `Conversa Geral` e slug `conversa-geral`.
- Endereço esperado na duplicata, ou duplicata já desativada e sem endereço após correção.
- Nenhuma mensagem na duplicata, contando também mensagens excluídas logicamente ou ocultas pela moderação.
- Nenhuma terceira sala ocupando o endereço e nenhuma divergência de estado da cidade.

Qualquer divergência causa erro explícito e rollback integral. A correção usa transação, `lock_timeout = 10s` e locks em `City`, `Room` e `RoomMessage`, impedindo inserções concorrentes entre a contagem e a desativação. Não apaga nem consolida dados automaticamente. Banco vazio e instalações cuja sala original já é `conversa-geral` mantêm as salas cadastradas pela migration anterior.

O seed executa a mesma política em transação: prefere a original `geral`, valida qualquer duplicata antes de desativá-la e não recria nem reativa a duplicata após a correção. Também preserva cidades e salas desativadas. Seu uso é opcional no deploy; as migrations já cadastram as salas regionais.

## Privacidade por participação

Cada conexão/aba recebe uma participação independente, com identificador aleatório, usuário, sessão, sala e momento de ingresso registrados pelo servidor. O identificador fica apenas na memória da aba; não é compartilhado em armazenamento do navegador. Ter a mesma conta aberta em outra aba não herda sua janela de mensagens.

A migration adicional `20260907121000_room_message_order` acrescenta `RoomMessage.position` (`BIGSERIAL`) e índice por sala/posição. No ingresso, a API reserva um marco na mesma sequência PostgreSQL e registra `clock_timestamp()`. HTTP e Socket.IO só disponibilizam mensagens cuja posição seja posterior ao marco dessa participação. Assim, timestamps iguais, relógios diferentes e entregas atrasadas não fazem uma mensagem anterior atravessar a fronteira. Datas e marcos enviados pelo navegador não definem acesso. IDs, conteúdo, timestamps e vínculos históricos existentes permanecem intactos; somente a nova coluna de ordenação é preenchida.

Comportamento definido:

- Primeira entrada, troca de sala e retorno após saída explícita iniciam nova participação e limpam a tela. Só aparecem mensagens posteriores ao novo ingresso.
- Nesta implementação, **toda desconexão encerra a participação**, inclusive uma queda breve. A reconexão inicia outra participação e não recupera mensagens do período anterior ou da ausência. Reinício da API tem o mesmo resultado. Não há credencial de retomada de participação.
- Mensagens recebidas durante a participação continuam visíveis quando o remetente sai. A consulta não filtra pelo estado de presença do autor; exclusão lógica e moderação continuam sendo respeitadas.
- Reservadas dentro da sala obedecem ao mesmo marco, além da restrição a autor/destinatário e das regras de bloqueio.
- Conversas privadas aceitas mantêm o histórico e o comportamento existentes, inclusive quando a sala regional da URL está indisponível. O acesso privilegiado a denúncias para moderação continua separado do histórico público.

## Contratos e sincronização

- `GET /api/rooms`: catálogo autenticado com cidade e sala ativas. O campo `slug` da resposta é o endereço público, com fallback para ID. O seletor usa o ID original; a duplicata desativada não aparece. `GET /api/rooms/:idOuSlug` resolve a mesma sala.
- `room:join(idOuSlug, ack)`: exige referência explícita, encerra a participação anterior e retorna `{ ok: true, roomId, participationId, joinedAt }`. Objetos com datas do cliente não são aceitos como referência.
- `room:leave(null, ack)`: encerra a participação da conexão, remove presença e assinatura da sala. Não afeta outras abas.
- `GET /api/rooms/:idOuSlug/messages`: exige sessão ativa, perfil e header `X-Room-Participation` emitido no ingresso. Identificador ausente, inventado, de outra sessão/sala ou encerrado recebe 403. A validade é checada novamente depois da consulta. Resposta com `Cache-Control: no-store`.
- A consulta retorna as mensagens visíveis da participação em ordem de posição, com `participationId` e sem expor a posição interna. O antigo corte de 50 mensagens foi removido para não perder mensagens durante o ingresso; ainda não há paginação. Reservadas só são retornadas ao autor/destinatário; públicas mantêm o indicador de bloqueio existente.
- `room:message({ roomId, content, recipientId? }, ack)`: revalida sessão, participação e sala/cidade ativas. Campos extras e imagens continuam recusados.
- `room:message:new`: cada entrega é filtrada pelo marco da participação destinatária e contém `roomId` e `participationId`. Reservadas só chegam às abas dos dois usuários que estejam nessa sala e cuja participação permita aquela mensagem.
- `room:presence`: `{ roomId, participants }`. O evento legado `room:participants` permanece disponível.

Entradas, saídas e envios são serializados por socket. O marco é reservado antes da assinatura Socket.IO. Após o ack, o frontend consulta a janela autorizada e combina a resposta com eventos recebidos durante a entrada, deduplicando pelo ID da mensagem. Isso cobre tanto mensagens gravadas antes da assinatura quanto eventos recebidos antes do ack. Respostas/eventos de outra sala, de participação anterior ou de conexão encerrada são descartados. O envio só é habilitado após a entrada e a sincronização.

Mudar de sala não altera a cidade do perfil. Convites entre cidades de perfil diferentes ainda exigem presença conjunta em sala ativa, consentimento, preferências e ausência de bloqueio. Armazenamento e acesso à mídia privada não foram alterados.

## Implantação e ensaio

1. Faça backup e ensaie em uma cópia restaurada. Registre o resultado desta consulta antes/depois, incluindo IDs e quantidade total de mensagens:

   ```sql
   SELECT c.slug AS city, c.state, r.id, r.name, r.slug, r."publicSlug", r.active,
          COUNT(m.id) AS messages
   FROM "Room" r JOIN "City" c ON c.id = r."cityId"
   LEFT JOIN "RoomMessage" m ON m."roomId" = r.id
   WHERE c.slug IN ('teofilo-otoni', 'mucuri')
   GROUP BY c.slug, c.state, r.id
   ORDER BY c.slug, r.slug;
   ```

2. Pare a API antiga durante a janela de implantação. A política nova requer API e frontend compatíveis; uma API antiga ainda disponibilizaria histórico anterior. Use uma única instância da API nesta arquitetura.
3. Com o `DATABASE_URL` do ambiente de ensaio confirmado, execute `npm run db:deploy --workspace @binger/api`. A migration aplicada anteriormente não deve ser editada, apagada ou marcada como pendente. Aplique as duas migrations novas antes de iniciar a API ou executar o seed atualizado.
4. No cenário observado, confirme que a sala original conserva seu ID, slug `geral` e as 24 mensagens, agora com endereço `teofilo-otoni-mg`. Confirme que `cregionalroomteofilootoni` continua no banco, vazia, desativada e com endereço nulo. Repita o seed no ensaio e confirme os mesmos resultados. Em instalações com `conversa-geral` original, seu ID e histórico devem permanecer intactos.
5. Publique API e frontend da mesma revisão e recarregue os clientes. Confirme que endereço público e URL por ID levam à sala original e que o seletor não oferece a duplicata. Com contas e abas distintas, envie públicas/reservadas antes e depois de novas entradas. Confira a resposta HTTP com o header da participação, tente sem header e confirme 403; confira também saída, troca de sala, reconexão e continuidade do privado.
6. Se houver erro de identidade, mensagens na duplicata, conflito de endereço ou lock, mantenha a aplicação parada, inspecione os dados e o registro da migration no Prisma. Não apague mensagens nem force a resolução como aplicada. Somente após diagnóstico e correção manual autorizada, marque uma tentativa efetivamente revertida como `--rolled-back` e reaplique. Não reverta para uma API que exponha histórico anterior enquanto a nova política estiver em vigor; um rollback da aplicação precisa preservar essa política. Mantenha os dados e as colunas aditivas.

Os testes automatizados não acessam o `DATABASE_URL` configurado: SQL e seed regional são exercitados em PostgreSQL isolado via PGlite; HTTP e Socket.IO usam repositório de teste. Eles não substituem o ensaio com locks e concorrência no PostgreSQL da VPS. Presença, participações, emissões e limites continuam locais ao processo. Escalar para múltiplas instâncias exige compartilhar o estado de participação e usar adapter distribuído; apenas afinidade de Socket.IO não basta, pois as requisições HTTP precisam validar o mesmo estado.

## Validação local

```sh
npm run test --workspace @binger/api
npm run test --workspace @binger/web
npm run build --workspace @binger/api
npm run build --workspace @binger/web
npx prisma validate --schema apps/api/prisma/schema.prisma
```

`rooms-migration.test.ts` reproduz `geral` com 24 mensagens, banco vazio e instalação com `conversa-geral`; aplica a sequência e repete o seed. Verifica preservação, FK, unicidade, catálogo e rollback em dados inesperados. `rooms.test.ts` cobre acesso direto à API, datas/identificadores forjados, públicas/reservadas anteriores, remetente ausente, múltiplas abas, entrega atrasada, consulta em voo após saída e mais de 50 mensagens durante ingresso. `Chat.test.tsx` cobre o seletor com `Sala Geral`, descarte de mensagens de outra participação, eventos anteriores ao ack, deduplicação, troca, reconexão, mobile e conversas privadas.
