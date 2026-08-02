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
