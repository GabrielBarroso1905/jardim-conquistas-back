# CORS — integração do frontend

A API usa JWT no header `Authorization`, **sem cookies de sessão**. O Nest está configurado com `credentials: false` em [`src/main.ts`](../src/main.ts).

## Erro típico no DevTools

Várias rotas (`me`, `channels-linked`, `generate`, `bot-info`) aparecem como **CORS error** com `0.0 kB` quando:

1. O `fetch` usa `credentials: "include"` (incompatível com a API).
2. A origin local (ex. `http://localhost:8080`) não está em `CORS_ALLOWED_ORIGINS` no ambiente remoto.
3. O proxy retorna **502/503** sem headers CORS (o browser rotula como CORS, não como 503).

## Correção obrigatória no front (`auth.ts` e demais clients)

Use **`credentials: "omit"`** (ou omita a opção — o default é `same-origin`, mas em chamadas cross-origin use `omit` explicitamente).

```typescript
const API_BASE = import.meta.env.VITE_API_URL; // ex. https://api.production.sowtech.io

export async function apiFetch(path: string, token: string | null, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'omit',
  });
}
```

**Não use** `credentials: "include"` com esta API — o servidor não envia `Access-Control-Allow-Credentials: true`.

Rotas afetadas no fluxo de vínculo (exemplos):

| Chamada | Método |
| --- | --- |
| `/api/users/link/generate` | POST |
| `/api/users/link/bot-info` | GET |
| `/api/users/:id/channels-linked` | GET |
| `/api/users/me` | GET |

Substituir em cada `fetch` que hoje define `credentials: "include"`.

## Headers opcionais

- `X-Timezone` / `Timezone` — permitidos no CORS (cadastro/login).
- `Authorization` — permitido; dispara **preflight OPTIONS** em GET/POST cross-origin.

## Ambiente local contra API de production

No Coolify do serviço **api.production**, inclua na variável `CORS_ALLOWED_ORIGINS` (vírgula, **sem barra final**):

```text
https://jardim.sowtech.io,http://localhost:8080,http://localhost:5173
```

Sem `http://localhost:8080`, o preflight falha mesmo com `credentials: "omit"`.

## Validação no browser

1. `GET https://api.<env>/health` deve retornar `{"status":"ok",...}` (não 503).
2. Na aba Network, abrir a requisição **OPTIONS** da rota:
   - `Access-Control-Allow-Origin: http://localhost:8080`
   - **sem** exigir `Access-Control-Allow-Credentials` quando o front usa `omit`.
3. O **GET** seguinte deve retornar 200/201, não CORS error.

## Referência backend

- [`src/config/cors.util.ts`](../src/config/cors.util.ts) — lista de origens ou reflect (`*`)
- [`docs/USER_ONBOARDING_AND_LINKING.md`](./USER_ONBOARDING_AND_LINKING.md) — cadastro e vínculo
- [`docs/PRODUCTION_TROUBLESHOOTING.md`](./PRODUCTION_TROUBLESHOOTING.md) — 503 e deploy