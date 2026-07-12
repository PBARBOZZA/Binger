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

Em desenvolvimento, `DEV_EXPOSE_EMAIL_TOKENS=true` devolve o token de confirmação na resposta. Isso deve ser `false` em produção e substituído por envio transacional.

## Docker Compose

Depois de configurar `.env`: `docker compose up --build`. A interface fica em `http://localhost:8080` e a API em `http://localhost:3001`. Rode o seed uma vez com `docker compose exec api npx prisma db seed --schema prisma/schema.prisma`.

## Produção em VPS

Use DNS e Caddy/Nginx na frente dos containers, TLS automático, `WEB_ORIGIN` e `VITE_API_URL` HTTPS do domínio real, banco sem porta pública e segredos aleatórios em gerenciador próprio. Defina backups diários criptografados com teste periódico de restauração. Centralize logs sem conteúdo privado completo, configure alertas no `/health`, limite recursos dos containers e aplique atualizações de segurança.

## Segurança e retenção

Implementado: Argon2id, sessão opaca armazenada como hash, cookie HttpOnly/SameSite/Secure em produção, revogação, CORS restrito, Helmet, limites de corpo e requisições, texto puro, bloqueio de URLs, autorização REST/WebSocket, minimização de IP por HMAC, auditoria administrativa e prioridade crítica para suspeita de menor.

Riscos ainda abertos antes de operação pública: serviço de e-mail real; recuperação/alteração de senha; CSRF token dedicado para navegadores legados; rate limit distribuído e antifraude; verificação etária externa; moderação operacional 24/7; política jurídica de retenção/LGPD revisada; exportação/exclusão automatizadas; backup restaurado em ensaio; WAF; observabilidade; testes de invasão; mensagens privadas completas e UI de moderação. O MVP não oferece criptografia ponta a ponta.

## Próxima versão

Redis para presença e limites, fila de e-mail, recuperação de senha, exportação/exclusão LGPD, preferências de convite, conversa privada completa, ferramentas de moderação, exclusão curta auditada, paginação por cursor, notificações opt-in e provedor externo de maioridade.

## Testes e validação

- `npm test`: regras unitárias de idade e conteúdo.
- `npm run build`: TypeScript e builds de produção.
- Fluxos com banco devem ser cobertos por integração em ambiente PostgreSQL isolado antes do lançamento.

## Checklist de implantação

- [ ] Todos os segredos e credenciais foram rotacionados.
- [ ] `DEV_EXPOSE_EMAIL_TOKENS=false` e e-mail transacional configurado.
- [ ] HTTPS, cookies Secure, CORS e CSP apontam somente ao domínio final.
- [ ] Migrations e seed executados; administrador acessível e senha trocada.
- [ ] Backup e restauração testados.
- [ ] Termos, Privacidade e retenção revisados juridicamente.
- [ ] Moderação, canal de denúncia e resposta a incidentes definidos.
- [ ] Testes, build, health checks e teste de carga aprovados.
- [ ] Banco e API não possuem portas administrativas públicas.
