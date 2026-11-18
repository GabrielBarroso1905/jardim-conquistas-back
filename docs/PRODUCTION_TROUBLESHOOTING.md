# Production — troubleshooting rápido

## Sintoma: tudo “CORS error” e `bot-info` com 503

### 1. Health check

```bash
curl -sS -o /dev/null -w "%{http_code}" https://api.production.sowtech.io/health
```

- **200** + JSON `status: ok` → aplicação no ar; investigar CORS no front (`credentials: omit`) e `CORS_ALLOWED_ORIGINS`.
- **503/502** → o **proxy/Coolify** está respondendo sem o Nest. O browser costuma mostrar **CORS error** nas outras rotas porque a resposta de erro **não** traz `Access-Control-Allow-Origin`.

### 2. Logs do container (Coolify)

Conferir no deploy de **api.production**:

| Verificar | Sintoma comum |
| --- | --- |
| `DATABASE_URL` | crash no boot / Prisma |
| `JWT_SECRET` (≥ 16) | falha na validação de env |
| `OPENAI_API_KEY` | falha na validação de env |
| `TELEGRAM_BOT_TOKEN` | `TelegramService` lança na inicialização |
| `npx prisma migrate deploy` | erro após release |
| Build: `prisma generate` + `npm run build` | container antigo ou sem client |

Reiniciar o serviço após corrigir env e garantir que o health passa.

### 3. CORS em production com front local

Ver [CORS_FRONTEND.md](./CORS_FRONTEND.md) e ajustar no Coolify:

```text
CORS_ALLOWED_ORIGINS=https://jardim.sowtech.io,http://localhost:8080
```

Redeploy não é obrigatório só para CORS — basta reiniciar o processo se a env for lida no boot.

### 4. Dev local: DB production, storage main (overlay)

Se `supabase.production` lista arquivos mas o download retorna 404 (blob ausente), você pode manter `DATABASE_URL` do `.env` e apontar **só o storage** para o main:

```env
STORAGE_ENV_OVERLAY=.env_main
PUBLIC_BASE_URL=http://localhost:3000
```

O overlay aplica `SUPABASE_*` de `.env_main` e define `ASSETS_PUBLIC_BASE_URL` a partir do `PUBLIC_BASE_URL` do arquivo main (`https://api.sowtech.io`). Webhooks locais continuam com `PUBLIC_BASE_URL` do `.env`.

Reinicie o Nest após alterar. Valide: `GET http://localhost:3000/api/assets/assets/words/lago/Lago.svg` → 200.

### 5. Diferença main vs production

- **api.sowtech.io** e **api.production.sowtech.io** são instâncias separadas (banco, storage, env).
- Um JWT emitido em um ambiente **não** valida no outro se `JWT_SECRET` for diferente.
- Teste sempre o health do **mesmo host** que o front usa no `VITE_API_URL`.