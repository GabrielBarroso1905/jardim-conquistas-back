# Jardim das Conquistas — backend

API NestJS do Jardim das Conquistas: metas com agenda, jardim virtual (SVG/árvores), conversa por Telegram e WhatsApp, resumo diário e lembretes no cron.

Sobe na porta **`PORT`** (Coolify/Docker) ou **3000** local. CORS configurável via `CORS_ALLOWED_ORIGINS`. Documentação interativa: **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)** (Swagger).

## O que o sistema faz

- **Metas:** `Goal` + `GoalSchedule` + `GoalReminder` na mesma transação de criação. Slots são o par (dia civil no fuso do usuário, `HH:mm`).
- **Lembretes:** policy avalia, claim grava, depois envia. Telegram/WhatsApp só entregam a mensagem; o pipeline de entrada fica em `inbound`. Detalhe do contrato: [`docs/superpowers/specs/2026-09-04-reminder-occurrence-contract.md`](docs/superpowers/specs/2026-09-04-reminder-occurrence-contract.md).
- **Jardim:** mundos SVG, âncoras, catálogo e árvores plantadas, eventos de crescimento, WebSocket (Socket.IO) para o front.
- **Auth:** JWT. `JWT_SECRET` é obrigatório (mínimo 16 caracteres), sem fallback de desenvolvimento.

## Stack

- NestJS 11, Prisma 5 + PostgreSQL
- OpenAI no orquestrador de conversa
- Telegram Bot API e WhatsApp via **Evolution**
- Storage S3-compatível (Garage) para assets; Supabase ainda entra no import legado de árvores
- Redis opcional (sessão / rate limit; sem `REDIS_URL` cai em memória)
- Luxon para fuso; Puppeteer / SVG.js no parsing de mundos

## Setup

```bash
npm install
npx prisma generate
npx prisma migrate deploy   # local: npx prisma migrate dev
```

Migrations recentes da PR de recados/visual de meta (aplicar antes do deploy do código novo): `20261103160000_daily_note`, `20261103180000_goal_icon_accent`.

Copie as variáveis para um `.env` na raiz (não commitar). O boot valida o schema em `src/config/env.validation.ts` e falha se o obrigatório faltar.

**Obrigatórias**

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | PostgreSQL |
| `JWT_SECRET` | Assinatura JWT (≥ 16 chars) |
| `OPENAI_API_KEY` | LLM da conversa |

**Opcionais úteis**

| Variável | Uso |
| --- | --- |
| `OPENAI_MODEL` | Default no Joi: `gpt-4o` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Bot Telegram |
| `EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY` | Cliente Evolution |
| `EVOLUTION_WEBHOOK_PATH` | Default `/api/evolution/webhook` |
| `PUBLIC_BASE_URL` | URL pública (webhook / proxy de assets) |
| `CORS_ALLOWED_ORIGINS` | Vírgula-separado: URL(s) do front; `*` ou omitir = qualquer origem (reflect) |
| `PORT` | Porta HTTP (Coolify define automaticamente) |
| `WHATSAPP_NUMBER` | Número da instância |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Garage / S3 |
| `REDIS_URL` | Redis |
| `SUPABASE_URL`, `SUPABASE_KEY` | Import de catálogo / legado |
| `REMINDER_GROUP_WINDOW_MINUTES` | Cluster de follow-up/last-chance (não agrupa operacional na policy) |

O Joi ainda aceita nomes antigos `WUZAPI_*`; o código de WhatsApp usa **Evolution**.

## Rodar

```bash
npm run start          # uma vez
npm run start:dev      # watch
npm run build && npm run start:prod   # dist/src/main.js
```

## Deploy (Coolify)

**Build command:**

```bash
npm ci
npx prisma generate
npm run build
```

**Start command:** `npm run start:prod`

Após release com migrations novas: `npx prisma migrate deploy` (one-off ou step de release).

Confirme no painel: `DATABASE_URL`, `JWT_SECRET` (≥ 16), `OPENAI_API_KEY` e `CORS_ALLOWED_ORIGINS` com a URL do frontend (e `http://localhost:8080` / `:5173` se o front local chama essa API). O front deve usar `fetch` com `credentials: "omit"` — ver [docs/CORS_FRONTEND.md](docs/CORS_FRONTEND.md). Se o health retorna 503, ver [docs/PRODUCTION_TROUBLESHOOTING.md](docs/PRODUCTION_TROUBLESHOOTING.md).

Health check: `GET /health` → `{ "status": "ok", ... }`.

## Testes

```bash
npm run test
npm run test:cov
npm run typecheck
```

## Documentação

- **Cadastro, login e vínculo Telegram/WhatsApp:** [docs/USER_ONBOARDING_AND_LINKING.md](docs/USER_ONBOARDING_AND_LINKING.md)
- **CORS e `auth.ts` no front:** [docs/CORS_FRONTEND.md](docs/CORS_FRONTEND.md)
- **Production 503 / health:** [docs/PRODUCTION_TROUBLESHOOTING.md](docs/PRODUCTION_TROUBLESHOOTING.md)
- **Paridade de canais após vínculo:** [docs/CHANNEL_PARITY.md](docs/CHANNEL_PARITY.md)

## HTTP (resumo)

Bearer JWT na maioria das rotas autenticadas. Lista completa e DTOs: `/api/docs`.

| Área | Rotas |
| --- | --- |
| Health | `GET /health` |
| Usuários | `POST /api/users`, `POST /api/users/login`, `GET /api/users/me`, `PATCH /api/users/me` (nome), `PATCH /api/users/me/current-world`, `GET /api/users/me/daily-note`, `GET /api/users/me/reminders`, `GET /api/users/:id/telegram-linked`, `GET /api/users/:id/channels-linked` |
| Vínculo | `POST /api/users/link/generate`, `POST /api/users/link/telegram`, `POST /api/users/link/whatsapp`, `GET /api/users/link/bot-info` |
| Metas | `GET/POST /api/goals`, `GET /api/goals/visuals`, `GET/PATCH/DELETE /api/goals/:id` (`PATCH` aceita `icon`, `accentColor`, `scheduleConfig`) |
| Instâncias | `GET /api/goal-instances`, `POST /api/goal-instances/:id/complete` |
| Dashboard | `GET /api/dashboard?period=day\|week\|month&date=...` |
| Progresso | `GET /api/progress/week`, `/month`, `/streaks` |
| Áreas | `GET /api/areas` |
| Eventos | `GET/POST /api/events`, `GET/PATCH/DELETE /api/events/:id` |
| Guia | `GET /api/garden-guide/conversations`, mensagens `GET/POST .../conversations/:id/messages` |
| Mundos | SVG `GET/POST /api/worlds/:id/svg`, âncoras, `GET/DELETE /api/worlds/:id/trees`, import Supabase, planted-trees, progress/events |
| Assets | `GET /api/assets/*` (proxy/assinatura S3) |
| WhatsApp | `POST /api/evolution/webhook`, `GET /api/evolution/status`, `POST /api/whatsapp/webhook` |

## Estrutura

```
src/
├── auth/              # JWT
├── config/            # validação de env (Joi)
├── domain/types/      # ScheduleConfig, tipos de meta/conquista
├── filters/           # HTTP e Prisma
├── logging/
├── prisma/
├── storage/           # S3 / Garage
├── supabase/
├── main.ts
├── app.module.ts
└── modules/
    ├── areas/
    ├── daily-digest/
    ├── dashboard/
    ├── events/
    ├── goals/
    ├── ia/            # orquestrador e núcleos de conversa
    ├── inbound/       # pipeline após Telegram/WhatsApp
    ├── messaging/     # saída
    ├── progress/
    ├── reminder/      # policy, claim, planner, delivery
    ├── shared/
    ├── telegram/
    ├── users/
    ├── whatsapp/      # Evolution
    └── worlds/
```

Prisma: [`prisma/schema.prisma`](prisma/schema.prisma). Scripts extras: `migrate:schedule-at`, `migrate:tree-catalog-keys`, `s3:check-cors`, `s3:apply-cors`.

## Migrar PostgreSQL (Coolify → outro host)

Para copiar **schema + dados** do banco atual para outro (ex. Supabase), defina no `.env`:

- `DATABASE_URL` — origem (produção atual)
- `DATABASE_URL_NEW` — destino vazio

Pré-requisito: cliente PostgreSQL (`pg_dump`, `pg_restore`, `psql`) no PATH ([download Windows](https://www.postgresql.org/download/windows/)). Alternativa: imagem Docker `postgres:16` com os mesmos comandos apontando para as URLs do `.env`.

```bash
npm run db:transfer:dry-run   # testa conexão e mostra passos
npm run db:transfer             # gera backups/jardim-*.dump e restaura no destino
```

Recomenda-se pausar a API no Coolify durante o `pg_dump` para evitar writes no meio do backup. Após as contagens baterem:

1. Substitua `DATABASE_URL` pelo valor que estava em `DATABASE_URL_NEW` (local e no Coolify).
2. Redeploy; `npx prisma migrate status` deve ficar *up to date*.
3. Valide `GET /health`, login e uma meta/lembrete.
4. Guarde o `.dump` em `backups/` como rollback até validar em produção.

## Storage (Supabase privado)

Com `STORAGE_PROVIDER=supabase` (default quando `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` existem), o `StorageService` lê o bucket via **Supabase SDK** (download + `createSignedUrl`). Bucket **privado** é suportado: o servidor usa a service role; o front recebe URLs assinadas ou `S3_ASSET_PROXY=true` (`/api/assets/...`).

| Variável | Uso |
| --- | --- |
| `STORAGE_PROVIDER` | `supabase` ou `s3` (fallback Garage) |
| `SUPABASE_STORAGE_BUCKET` | Nome do bucket (ex. `jardim-das-conquistas`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Obrigatório no servidor** para bucket privado |
| `S3_ASSET_PROXY` + `PUBLIC_BASE_URL` ou `ASSETS_PUBLIC_BASE_URL` | Recomendado no front (Pixi same-origin) |
| `STORAGE_ENV_OVERLAY` | Arquivo extra (ex. `.env_main`) que sobrescreve só vars de Supabase/storage; útil com DB production e bucket main |

## Migrar storage (Garage/S3 → Supabase Storage)

Para **copiar** objetos do Garage para o Supabase antes do cutover:

### 1. Copiar objetos (mesmas keys, ex. `assets/pontual/...`)

No `.env`:

- **Origem:** `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (Garage atual)
- **Destino:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (obrigatório para upload; a `SUPABASE_KEY` publishable **não** serve)
- Opcional: `SUPABASE_STORAGE_BUCKET=jardim-das-conquistas` (default = `S3_BUCKET`)

```bash
npm run storage:transfer:dry-run              # conta objetos no Garage
npm run storage:transfer                        # copia tudo
npm run storage:transfer -- --prefix assets/    # só sob assets/
npm run storage:transfer -- --skip-existing    # retoma sem reenviar
```

### 2. Cutover no Coolify

Defina `STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` e mantenha `S3_ASSET_PROXY=true`. As variáveis `S3_*` podem ficar só para o script `storage:transfer` (origem Garage).

### Sincronizar main → production (local)

Com [`.env_main`](.env_main) (origem) e [`.env`](.env) (destino production):

```bash
npm run storage:transfer:supabase:dry-run -- --prefix assets/
npm run storage:transfer:supabase -- --prefix assets/

# Banco (requer pg_dump/psql no PATH):
npm run sync:main-to-prod -- --db-only --yes
# Ou tudo de uma vez:
npm run sync:main-to-prod -- --yes
```

### 3. Banco de dados (já alinhado se você rodou as migrations de keys)

- `World.svgPath` e `TreeCatalog.stages` devem usar **keys** `assets/...`, não URLs do Garage.
- Se ainda houver URLs antigas: `npm run migrate:tree-catalog-keys` e `npm run migrate:world-svg-keys`.

### 4. Validar

- `npm run s3:check-cors` (ou proxy) com o novo endpoint
- Abrir um mundo no front (SVG de fundo + estágios de árvore)
- `GET /api/assets/assets/...` se proxy ativo

### Self-hosted Supabase (`supabase.sowtech.io`)

Ajuste `SUPABASE_URL` (e endpoint S3, se diferente do cloud) para o host do seu stack. Se usar domínio próprio em URLs públicas, garanta CORS no bucket Storage.
