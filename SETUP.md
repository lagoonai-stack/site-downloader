# Configuração do login (Supabase + Kiwify)

## 1. Supabase

1. Abra o projeto no [supabase.com](https://supabase.com/dashboard) → **SQL Editor** → cole e rode o conteúdo de `supabase-schema.sql`. Isso cria:
   - um schema `private` com as tabelas `subscribers` e `kiwify_webhook_logs` (log de toda chamada recebida da Kiwify, válida ou não)
   - funções em `public` (`kiwify_upsert_subscriber`, `get_subscriber_status`, `log_kiwify_webhook`) que são o único ponto de acesso a essas tabelas, liberadas exclusivamente para o role `service_role`
2. Vá em **Project Settings → Data API → Exposed schemas** e confirme que **`private` NÃO está na lista** (por padrão não fica; é essencial que continue assim — é isso que garante que os dados nunca sejam alcançáveis via API, mesmo pelo `service_role`, exceto pelas funções controladas).
3. Vá em **Authentication → Sign In / Providers** e confirme que **Email** está habilitado.
4. Vá em **Authentication → Emails → Magic Link** e confirme que o template contém `{{ .Token }}` (é o código de 6 dígitos que o usuário digita — nosso login não depende de clicar em link).
5. Vá em **Project Settings → API** e copie:
   - **Project URL** → `SUPABASE_URL` no `.env`
   - **service_role** key (não a `anon`!) → `SUPABASE_SERVICE_ROLE_KEY` no `.env`

## 2. Variáveis de ambiente (`.env`)

Preencha o arquivo `.env` na raiz do projeto:

```
SESSION_SECRET=   # gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
KIWIFY_WEBHOOK_TOKEN=   # mesmo valor que você configurar no campo "Token" da Kiwify
```

Em produção, defina também `NODE_ENV=production` (necessário para o cookie de sessão exigir HTTPS).

## 3. Webhook da Kiwify

No painel da Kiwify, em **Webhooks**, configure:

- **URL do Webhook**: `https://gprgai.top/webhooks/kiwify`
  (nunca aponte para a URL do Supabase diretamente — o seu servidor é quem fala com o Supabase, usando a `service_role key` que fica só no `.env`)
- **Token**: o mesmo valor de `KIWIFY_WEBHOOK_TOKEN` no `.env`
- **Eventos**: marque pelo menos "Compra aprovada", "Reembolso", "Chargeback", "Assinatura cancelada" e "Assinatura renovada" (assim o acesso é revogado automaticamente em cancelamentos/reembolsos).

Depois de configurar, use o botão **"Testar Webhook"** da Kiwify e confira o log do servidor (`console.warn`/`console.error` em `kiwifyWebhook.js`) para validar que o e-mail do cliente está sendo lido corretamente do payload — o formato exato do payload da Kiwify pode variar, então esse teste é o jeito mais confiável de confirmar antes de ir para produção. Se o campo de e-mail vier em outro lugar do JSON, ajuste a função `handleKiwifyEvent` em `kiwifyWebhook.js`.

## 4. Rodando localmente

```
npm install
npm start
```

Acesse `http://localhost:3000` — sem sessão válida, você será redirecionado para `/login.html`.

## 5. Como o acesso é revogado

Quando a Kiwify envia um evento de reembolso/chargeback/cancelamento, o webhook marca o assinante como `canceled` na tabela `private.subscribers`. Como toda rota protegida reconfere esse status a cada requisição (não confia só no cookie), o acesso é cortado imediatamente na próxima ação do usuário — não é preciso esperar o cookie expirar.

## 6. Auditoria do webhook

Toda chamada recebida em `/webhooks/kiwify` — inclusive com token inválido — fica registrada em `private.kiwify_webhook_logs` (via a função `log_kiwify_webhook`), com o payload bruto, se o token era válido, e o erro de processamento (se houve). Para consultar, rode no SQL Editor do Supabase:

```sql
select received_at, token_valid, event_status, customer_email, processing_error
from private.kiwify_webhook_logs
order by received_at desc
limit 50;
```
