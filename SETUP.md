# Configuração (Supabase + Kiwify)

Este app não tem mais login próprio — ele vive atrás de `app.brabospace.com/downloader`
(Strip Path ligado no Dokploy) e só é chamado via `fetch()` pelo front da BraboSpace, nunca
navegado direto. A autenticação é o token de sessão que o usuário já tem por estar logado na
BraboSpace, verificado em `requireBraboSpaceUser.js`.

## 1. Autenticação com a BraboSpace

A BraboSpace e este app usam projetos Supabase **diferentes**. Pra validar o token de sessão
que o front da BraboSpace envia (header `Authorization: Bearer <token>`), este app precisa
falar com o projeto Supabase *da BraboSpace* (não o próprio):

- `BRABOSPACE_SUPABASE_URL` → Project URL do projeto Supabase da brabo-academy
- `BRABOSPACE_SUPABASE_ANON_KEY` → chave `anon` (pública) desse mesmo projeto

Além do token válido, o e-mail do usuário precisa estar na lista `ALLOWED_EMAILS` em
`requireBraboSpaceUser.js` — mantenha essa lista em sincronia com
`src/lib/downloaderAccess.ts` no repo da brabo-academy.

## 2. Supabase deste app (Kiwify)

O projeto Supabase próprio (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) continua existindo só
para o webhook da Kiwify (`kiwifyWebhook.js`) — registro de assinantes/log de eventos, sem
relação com quem pode acessar o Downloader hoje.

1. Abra o projeto no [supabase.com](https://supabase.com/dashboard) → **SQL Editor** → cole e
   rode o conteúdo de `supabase-schema.sql`. Isso cria:
   - um schema `private` com as tabelas `subscribers` e `kiwify_webhook_logs` (log de toda chamada recebida da Kiwify, válida ou não)
   - funções em `public` (`kiwify_upsert_subscriber`, `get_subscriber_status`, `log_kiwify_webhook`) que são o único ponto de acesso a essas tabelas, liberadas exclusivamente para o role `service_role`
2. Vá em **Project Settings → Data API → Exposed schemas** e confirme que **`private` NÃO está na lista** (por padrão não fica; é essencial que continue assim).
3. Vá em **Project Settings → API** e copie:
   - **Project URL** → `SUPABASE_URL` no `.env`
   - **service_role** key (não a `anon`!) → `SUPABASE_SERVICE_ROLE_KEY` no `.env`

## 3. Variáveis de ambiente (`.env`)

```
PORT=3000
NODE_ENV=production

BRABOSPACE_SUPABASE_URL=          # Project URL do Supabase da brabo-academy
BRABOSPACE_SUPABASE_ANON_KEY=     # chave anon (pública) do Supabase da brabo-academy

SUPABASE_URL=                     # Project URL deste app (Kiwify)
SUPABASE_SERVICE_ROLE_KEY=        # service_role key deste app (Kiwify)
KIWIFY_WEBHOOK_TOKEN=             # mesmo valor configurado no campo "Token" da Kiwify
```

## 4. Webhook da Kiwify

No painel da Kiwify, em **Webhooks**, configure:

- **URL do Webhook**: `https://gprgai.top/webhooks/kiwify`
  (nunca aponte para a URL do Supabase diretamente — o seu servidor é quem fala com o Supabase, usando a `service_role key` que fica só no `.env`)
- **Token**: o mesmo valor de `KIWIFY_WEBHOOK_TOKEN` no `.env`
- **Eventos**: marque pelo menos "Compra aprovada", "Reembolso", "Chargeback", "Assinatura cancelada" e "Assinatura renovada".

Depois de configurar, use o botão **"Testar Webhook"** da Kiwify e confira o log do servidor (`console.warn`/`console.error` em `kiwifyWebhook.js`) para validar que o e-mail do cliente está sendo lido corretamente do payload. Se o campo de e-mail vier em outro lugar do JSON, ajuste a função `handleKiwifyEvent` em `kiwifyWebhook.js`.

## 5. Rodando localmente

```
npm install
npm start
```

O servidor sobe em `http://localhost:3000`, mas só responde de verdade a chamadas com um
token válido da BraboSpace no header `Authorization` — pra testar de ponta a ponta, use o
front da brabo-academy local apontando pra esse servidor (ver `src/lib/downloaderApi.ts`).

## 6. Auditoria do webhook

Toda chamada recebida em `/webhooks/kiwify` — inclusive com token inválido — fica registrada em `private.kiwify_webhook_logs` (via a função `log_kiwify_webhook`), com o payload bruto, se o token era válido, e o erro de processamento (se houve). Para consultar, rode no SQL Editor do Supabase:

```sql
select received_at, token_valid, event_status, customer_email, processing_error
from private.kiwify_webhook_logs
order by received_at desc
limit 50;
```
