-- 0005 — accept a DeepSeek credential string without the Edge Function.
--
-- The operator flow is: paste one string (Copy-as-cURL / userToken / dscred1:…), the shared
-- parser turns it into {token, deviceId, cookie, userAgent}, and it lands in the database.
-- That path went through the Edge Function, which verifies the string against the live API —
-- but the function needs a SUPABASE_ACCESS_TOKEN to deploy, and until it is deployed the
-- paste box on the hidden backend page had nothing to talk to.
--
-- So the same write also exists over PostgREST, gated by TOOLS_ADMIN_TOKEN. The token itself
-- is not stored: only its sha256, seeded by scripts/admin-secret.mjs. Without the function the
-- string cannot be checked against DeepSeek here (CORS), so the row is marked unverified and
-- the next turn reports the outcome through deepseek_credential_report() — the status strip
-- says 登录态异常 instead of failing silently.

create table if not exists public.tools_secret (
  name       text primary key,
  algo       text not null default 'sha256',
  digest     text not null,
  hint       text,
  updated_at timestamptz not null default now()
);

comment on table public.tools_secret is
  'Hashes of operator secrets (admin token). Never readable by anon; the RPCs compare digests.';

alter table public.tools_secret enable row level security;
revoke all on public.tools_secret from anon, authenticated;
grant select on public.tools_secret to service_role;

-- Guess-rate guard for the admin token: a global counter per five-minute bucket, so a wrong
-- token cannot be brute-forced over HTTPS. Mirrors the clipboard attempt table.
create table if not exists public.tools_auth_attempt (
  bucket     text primary key,
  failed     integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.tools_auth_attempt enable row level security;
revoke all on public.tools_auth_attempt from anon, authenticated;

create or replace function app.tools_attempt_bucket(p_minutes integer default 5)
returns text
language sql stable
as $$
  select to_char(
    to_timestamp(floor(extract(epoch from now()) / (p_minutes * 60)) * (p_minutes * 60)),
    'YYYYMMDDHH24MI'
  );
$$;

-- Store the credential the browser parsed. Returns the same shape as the Edge Function's
-- credential_set action (minus the upstream verification), so the UI has one code path.
create or replace function public.deepseek_credential_set_admin(
  p_token       text,
  p_admin_token text,
  p_device_id   text default null,
  p_cookie      text default null,
  p_user_agent  text default null,
  p_source      text default 'browser'
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_secret  record;
  v_given   text := coalesce(p_admin_token, '');
  v_token   text := btrim(coalesce(p_token, ''));
  v_bucket  text;
  v_attempt record;
  v_row     public.deepseek_credential%rowtype;
begin
  select * into v_secret from public.tools_secret where name = 'admin_token';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'admin_disabled: 未写入管理令牌哈希（npm run admin:secret）');
  end if;

  v_bucket := app.tools_attempt_bucket(5);
  select * into v_attempt from public.tools_auth_attempt where bucket = v_bucket;
  if found and v_attempt.failed >= 20 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts', 'retry_after_seconds', 300);
  end if;

  if v_given = '' or encode(digest(v_given, 'sha256'), 'hex') <> v_secret.digest then
    insert into public.tools_auth_attempt as a (bucket, failed, updated_at)
         values (v_bucket, 1, now())
    on conflict (bucket) do update set failed = a.failed + 1, updated_at = now();
    return jsonb_build_object('ok', false, 'error', 'bad_admin_token');
  end if;

  if char_length(v_token) < 16 or char_length(v_token) > 512 then
    return jsonb_build_object('ok', false, 'error', 'bad_token', 'min', 16, 'max', 512);
  end if;
  if coalesce(char_length(coalesce(p_cookie, '')), 0) > 4096 then
    return jsonb_build_object('ok', false, 'error', 'cookie_too_long', 'max', 4096);
  end if;
  if coalesce(p_source, '') not in ('browser', 'canonical', 'curl', 'json', 'kv', 'token', 'db', 'env') then
    return jsonb_build_object('ok', false, 'error', 'bad_source');
  end if;

  insert into public.deepseek_credential
      (token, device_id, cookie, user_agent, source, note, updated_at, last_ok_at)
  values
      (v_token,
       nullif(btrim(coalesce(p_device_id, '')), ''),
       nullif(btrim(coalesce(p_cookie, '')), ''),
       nullif(btrim(coalesce(p_user_agent, '')), ''),
       coalesce(nullif(btrim(p_source), ''), 'browser'),
       'stored over PostgREST, not checked against the upstream',
       now(), null)
  on conflict (id) do update
     set token = excluded.token,
         device_id = excluded.device_id,
         cookie = excluded.cookie,
         user_agent = excluded.user_agent,
         source = excluded.source,
         note = excluded.note,
         updated_at = now(),
         -- an unverified write must not look like a working login
         last_ok_at = null,
         last_error = null
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'source', v_row.source,
    'token_hint', left(v_row.token, 4) || '…' || right(v_row.token, 4),
    'has_device_id', v_row.device_id is not null,
    'has_cookie', v_row.cookie is not null,
    'verified', false,
    'updated_at', v_row.updated_at,
    'note', v_row.note
  );
end;
$$;

-- Seed / inspect the admin-token hash (service_role only — the digest never comes back).
create or replace function public.tools_secret_set(
  p_name   text,
  p_digest text,
  p_hint   text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 64);
begin
  if v_name = '' or char_length(coalesce(p_digest, '')) <> 64 then
    return jsonb_build_object('ok', false, 'error', 'bad_digest');
  end if;
  insert into public.tools_secret as s (name, algo, digest, hint, updated_at)
       values (v_name, 'sha256', lower(p_digest), left(coalesce(p_hint, ''), 64), now())
  on conflict (name) do update
     set algo = 'sha256', digest = lower(excluded.digest), hint = excluded.hint, updated_at = now();
  return jsonb_build_object('ok', true, 'name', v_name, 'algo', 'sha256');
end;
$$;

-- ---------------------------------------------------------------------------
-- grants + ownership
-- ---------------------------------------------------------------------------

alter function app.tools_attempt_bucket(integer)                       owner to postgres;
alter function public.deepseek_credential_set_admin(text, text, text, text, text, text) owner to postgres;
alter function public.tools_secret_set(text, text, text)               owner to postgres;

revoke all on function app.tools_attempt_bucket(integer)               from public;
revoke all on function public.deepseek_credential_set_admin(text, text, text, text, text, text) from public;
revoke all on function public.tools_secret_set(text, text, text)       from public;

grant execute on function app.tools_attempt_bucket(integer)            to anon, authenticated, service_role;
grant execute on function public.deepseek_credential_set_admin(text, text, text, text, text, text)
  to anon, authenticated, service_role;
grant execute on function public.tools_secret_set(text, text, text)    to service_role;
