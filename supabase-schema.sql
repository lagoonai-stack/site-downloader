drop table if exists public.subscribers;
create schema if not exists private;
create table if not exists private.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  status text not null default 'inactive', -- active | inactive | canceled
  kiwify_order_id text,
  kiwify_subscription_id text,
  product_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscribers_email_idx on private.subscribers (email);
alter table private.subscribers enable row level security;
create table if not exists private.kiwify_webhook_logs (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  token_valid boolean not null,
  event_status text,
  customer_email text,
  payload jsonb not null,
  processing_error text
);
alter table private.kiwify_webhook_logs enable row level security;
create or replace function public.kiwify_upsert_subscriber(
  p_email text,
  p_status text,
  p_kiwify_order_id text default null,
  p_kiwify_subscription_id text default null,
  p_product_name text default null
) returns void
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  insert into private.subscribers (email, status, kiwify_order_id, kiwify_subscription_id, product_name, updated_at)
  values (lower(p_email), p_status, p_kiwify_order_id, p_kiwify_subscription_id, p_product_name, now())
  on conflict (email) do update
    set status = excluded.status,
        kiwify_order_id = excluded.kiwify_order_id,
        kiwify_subscription_id = excluded.kiwify_subscription_id,
        product_name = excluded.product_name,
        updated_at = now();
end;
$$;
create or replace function public.get_subscriber_status(p_email text)
returns text
language sql
security definer
set search_path = private, pg_temp
as $$
  select status from private.subscribers where email = lower(p_email);
$$;
create or replace function public.log_kiwify_webhook(
  p_token_valid boolean,
  p_event_status text,
  p_customer_email text,
  p_payload jsonb,
  p_processing_error text default null
) returns void
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  insert into private.kiwify_webhook_logs (token_valid, event_status, customer_email, payload, processing_error)
  values (p_token_valid, p_event_status, nullif(lower(coalesce(p_customer_email, '')), ''), p_payload, p_processing_error);
end;
$$;
revoke execute on function public.kiwify_upsert_subscriber(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_subscriber_status(text) from public, anon, authenticated;
revoke execute on function public.log_kiwify_webhook(boolean, text, text, jsonb, text) from public, anon, authenticated;

grant execute on function public.kiwify_upsert_subscriber(text, text, text, text, text) to service_role;
grant execute on function public.get_subscriber_status(text) to service_role;
grant execute on function public.log_kiwify_webhook(boolean, text, text, jsonb, text) to service_role;

-- Historico de downloads (guarda o zip no Storage tambem, bucket
-- "download-history" - criar manualmente no dashboard, ver SETUP.md).
create table if not exists private.download_history (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  url text not null,
  mode text not null,
  status text not null, -- success | error | canceled
  storage_path text,    -- null quando status != success
  file_name text,
  file_size bigint,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists download_history_user_email_idx
  on private.download_history (user_email, created_at desc);
alter table private.download_history enable row level security;

create or replace function public.insert_download_history(
  p_user_email text,
  p_url text,
  p_mode text,
  p_status text,
  p_storage_path text default null,
  p_file_name text default null,
  p_file_size bigint default null,
  p_error_message text default null
) returns void
language plpgsql
security definer
set search_path = private, pg_temp
as $$
begin
  insert into private.download_history
    (user_email, url, mode, status, storage_path, file_name, file_size, error_message)
  values
    (lower(p_user_email), p_url, p_mode, p_status, p_storage_path, p_file_name, p_file_size, p_error_message);
end;
$$;

create or replace function public.list_download_history(
  p_user_email text,
  p_limit int default 50,
  p_offset int default 0
) returns setof private.download_history
language sql
security definer
set search_path = private, pg_temp
as $$
  select * from private.download_history
  where user_email = lower(p_user_email)
  order by created_at desc
  limit p_limit offset p_offset;
$$;

-- Usada tanto pra gerar o signed URL de re-download quanto antes de
-- apagar - sempre confere que o e-mail bate com o dono do registro.
create or replace function public.get_download_history_entry(
  p_id uuid,
  p_user_email text
) returns setof private.download_history
language sql
security definer
set search_path = private, pg_temp
as $$
  select * from private.download_history
  where id = p_id and user_email = lower(p_user_email)
  limit 1;
$$;

create or replace function public.delete_download_history(
  p_id uuid,
  p_user_email text
) returns void
language sql
security definer
set search_path = private, pg_temp
as $$
  delete from private.download_history
  where id = p_id and user_email = lower(p_user_email);
$$;

revoke execute on function public.insert_download_history(text, text, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.list_download_history(text, int, int) from public, anon, authenticated;
revoke execute on function public.get_download_history_entry(uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_download_history(uuid, text) from public, anon, authenticated;

grant execute on function public.insert_download_history(text, text, text, text, text, text, bigint, text) to service_role;
grant execute on function public.list_download_history(text, int, int) to service_role;
grant execute on function public.get_download_history_entry(uuid, text) to service_role;
grant execute on function public.delete_download_history(uuid, text) to service_role;

-- Report de erro (URL + descricao + print opcional, bucket
-- "error-reports" - criar manualmente no dashboard, ver SETUP.md).
-- Revisao e feita via SQL direto (mesmo padrao de kiwify_webhook_logs),
-- nao ha painel de admin pra isso.
create table if not exists private.error_reports (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  url text not null,
  description text not null,
  screenshot_path text,
  created_at timestamptz not null default now()
);
create index if not exists error_reports_created_at_idx on private.error_reports (created_at desc);
alter table private.error_reports enable row level security;

create or replace function public.insert_error_report(
  p_user_email text,
  p_url text,
  p_description text,
  p_screenshot_path text default null
) returns uuid
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into private.error_reports (user_email, url, description, screenshot_path)
  values (lower(p_user_email), p_url, p_description, p_screenshot_path)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.insert_error_report(text, text, text, text) from public, anon, authenticated;
grant execute on function public.insert_error_report(text, text, text, text) to service_role;
