# Binger

MVP de uma praça digital regional anônima, exclusiva para maiores de 18 anos. Participantes veem apenas apelido, faixa etária, cidade e interesses; a plataforma preserva a responsabilidade por conta e sessão.

## Arquitetura

- `apps/web`: React 19, TypeScript, Vite, React Router, Socket.IO Client e PWA.
- `apps/api`: Express 5, Prisma/PostgreSQL, Argon2id, cookies HttpOnly e Socket.IO.
- PostgreSQL separa conta privada, perfil público, conteúdo, moderação, sessão e auditoria.
- REST atende autenticação, cidades, histórico, bloqueio, denúncia e administração; Socket.IO atende presença, sala e convites.

`AgeVerificationProvider` em `apps/api/src/age-verification.ts` isola a política de maioridade. O provedor básico exige data adulta, declaração e e-mail confirmado. Um fornecedor externo deve implementar a interface e devolver apenas resultado/referência, sem documentos. Para múltiplas instâncias, adicionar Redis Adapter no bootstrap do Socket.IO, mover presença/rate limit para Redis e e-mails para uma fila.

## Desenvolvimento

1. Requisitos: Node 20+, npm e PostgreSQL 15+ (ou Docker).
2. Copie `.env.example` para `.env` e troque todos os segredos e a senha administrativa.
3. Execute `npm install`.
4. Inicie PostgreSQL: `docker compose up -d db`.
5. Execute `npm run db:migrate` e `npm run db:seed`.
6. Em terminais separados: `npm run dev --workspace @binger/api` e `npm run dev --workspace @binger/web`.
7. Abra `http://localhost:5173`.

O cadastro e a recuperação de senha usam o mesmo transporte SMTP e remetente. As variáveis necessárias estão documentadas em `.env.example`; `DEV_EXPOSE_EMAIL_TOKENS` permanece desativado por padrão. Mesmo quando essa opção é habilitada localmente, ela se aplica somente à confirmação do cadastro: tokens de recuperação nunca são devolvidos pela API nem escritos em logs.

## Docker Compose

Depois de configurar `.env`: `docker compose up --build`. A interface fica em `http://localhost:8080` e a API em `http://localhost:3001`. Rode o seed uma vez com `docker compose exec api npx prisma db seed --schema prisma/schema.prisma`.

## Produção em VPS

Use DNS e Caddy/Nginx na frente dos containers, TLS automático, `WEB_ORIGIN` e `VITE_API_URL` HTTPS do domínio real, banco sem porta pública e segredos aleatórios em gerenciador próprio. Defina backups diários criptografados com teste periódico de restauração. Centralize logs sem conteúdo privado completo, configure alertas no `/health`, limite recursos dos containers e aplique atualizações de segurança.

## Segurança e retenção

Implementado: Argon2id, sessão opaca armazenada como hash, cookie HttpOnly/SameSite/Secure em produção, revogação, recuperação de senha por token opaco de uso único, CORS restrito, Helmet, limites de corpo e requisições, texto puro, bloqueio de URLs, autorização REST/WebSocket, minimização de IP por HMAC, auditoria administrativa e prioridade crítica para suspeita de menor.

### Mídia em conversas privadas

Imagens não são aceitas na sala pública nem em mensagens reservadas. Apenas participantes de uma conversa privada aceita podem enviar JPEG, PNG ou WebP; a API valida o conteúdo real, impõe limites e reprocessa o arquivo antes de guardá-lo como mídia privada. O arquivo fica em `PRIVATE_MEDIA_ROOT`, fora do checkout, de `/var/www/binger`, do diretório público e de qualquer raiz servida diretamente por Caddy ou Nginx. No Docker Compose, o volume `private_media_data` é montado somente no contêiner da API.

O acesso ocorre por endpoint autenticado e autorizado, sem URL pública permanente, com `Cache-Control: private, no-store`. Não há botão de download. Bloquear arrastar ou o menu de contexto é apenas uma camada de UX: nenhuma aplicação web consegue impedir que uma pessoa autorizada faça captura de tela, fotografe a tela ou copie o conteúdo.

Em produção, configure `PRIVATE_MEDIA_ROOT` como um caminho absoluto dedicado, com permissões apenas para o processo da API. Não crie uma regra Caddy/Nginx que sirva esse caminho, nem o inclua em backups públicos ou no Git. As imagens expiram conforme `PRIVATE_MEDIA_RETENTION_HOURS`; o autor pode usar “Apagar para todos” durante `PRIVATE_MESSAGE_DELETE_WINDOW_MINUTES`, e a rotina de limpeza remove arquivos excluídos, expirados e órfãos. Agende `npm run media:cleanup --workspace @binger/api` a cada 15 minutos (ou o equivalente `node dist/private-media-cleanup.js` no contêiner já compilado).

Riscos ainda abertos antes de operação pública: provedor SMTP transacional e monitoramento de entrega; CSRF token dedicado para navegadores legados; rate limit distribuído e antifraude; verificação etária externa; moderação operacional 24/7; política jurídica de retenção/LGPD revisada; exportação/exclusão automatizadas; backup restaurado em ensaio; WAF; observabilidade; testes de invasão; mensagens privadas completas e UI de moderação. O MVP não oferece criptografia ponta a ponta.

## Próxima versão

Redis para presença e limites, fila durável de e-mail, exportação/exclusão LGPD, preferências de convite, conversa privada completa, ferramentas de moderação, exclusão curta auditada, paginação por cursor, notificações opt-in e provedor externo de maioridade.

## Testes e validação

- `npm test`: regras unitárias de idade, conteúdo, validação de senha e sanitização de diagnósticos de e-mail.
- `npm run build`: TypeScript e builds de produção.
- Fluxos com banco devem ser cobertos por integração em ambiente PostgreSQL isolado antes do lançamento.

## Checklist de implantação

- [ ] Todos os segredos e credenciais foram rotacionados.
- [ ] Entrega transacional de e-mail validada no ambiente de produção.
- [ ] HTTPS, cookies Secure, CORS e CSP apontam somente ao domínio final.
- [ ] Migrations e seed executados; administrador acessível e senha trocada.
- [ ] Backup e restauração testados.
- [ ] Termos, Privacidade e retenção revisados juridicamente.
- [ ] Moderação, canal de denúncia e resposta a incidentes definidos.
- [ ] Testes, build, health checks e teste de carga aprovados.
- [ ] Banco e API não possuem portas administrativas públicas.
