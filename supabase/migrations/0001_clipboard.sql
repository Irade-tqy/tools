-- Tools toolbox — shared cloud clipboard.
-- Design notes (see README.md):
--   * Passwords live in clipboard_secret as bcrypt hashes (crypt()/gen_salt('bf')).
--   * A successful verify() mints a random 256-bit token; only its sha256 hash is stored.
--     Every later call authenticates with the "x-clipboard-token" request header.
--   * Shared mode: one logical clipboard, readable by any holder of a valid token.
--   * Text entries are stored as plaintext; file entries are stored as AES-GCM ciphertext
--     produced in the browser (key derived from the password), so Postgres never sees file
--     contents.
--   * Entries expire after app.clipboard_retention_days() days (default 7) and expired rows
--     are purged whenever the clipboard is touched.
--   * All tables are RLS-protected with no policies, and anon/authenticated have no table
--     grants: the only way in is through the SECURITY DEFINER RPCs below.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
comment on schema app is 'Internal helpers; not exposed through PostgREST.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.clipboard_secret (
  id         bigint generated always as identity primary key,
  label      text    not null unique,
  pw_hash    text    not null,
  created_at timestamptz not null default now()
);
comment on table public.clipboard_secret is 'Allowlist of accepted passwords, bcrypt hashed.';

create table if not exists public.clipboard_attempt (
  id         bigint generated always as identity primary key,
  bucket     text    not null,
  ok         boolean not null,
  created_at timestamptz not null default now()
);
comment on table public.clipboard_attempt is 'verify() audit/rate-limit log. bucket = sha256(password|day); never stores the password.';
create index if not exists clipboard_attempt_bucket_idx on public.clipboard_attempt (bucket, created_at);

create table if not exists public.clipboard_token (
  token_hash text primary key,
  secret_id  bigint not null references public.clipboard_secret (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table public.clipboard_token is 'Short-lived access tokens, sha256 hashed.';

create table if not exists public.clipboard_entry (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('text', 'file')),
  title       text not null default '',
  body        text,
  file_name   text,
  file_type   text not null default 'application/octet-stream',
  file_size   bigint not null default 0,
  data        bytea,
  iv          text,
  kdf_salt    text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  constraint clipboard_entry_payload_check check (
    (kind = 'text' and body is not null)
    or (kind = 'file' and data is not null and iv is not null)
  )
);
comment on table public.clipboard_entry is 'Shared clipboard items. kind=file rows hold client-side AES-GCM ciphertext.';
create index if not exists clipboard_entry_created_idx on public.clipboard_entry (created_at desc);
create index if not exists clipboard_entry_expires_idx on public.clipboard_entry (expires_at);

-- kdf_salt was added after the first deployment; kept here so re-applying this
-- migration on an existing database is a no-op.
alter table public.clipboard_entry add column if not exists kdf_salt text;

-- ---------------------------------------------------------------------------
-- Internal helpers (schema app: invisible to PostgREST)
-- ---------------------------------------------------------------------------

create or replace function app.clipboard_retention_days()
returns integer
language sql stable
set search_path = public, extensions
as $$
  select coalesce(
    nullif(current_setting('app.clipboard_retention_days', true), ''),
    '7'
  )::integer;
$$;

create or replace function app.clipboard_max_file_bytes()
returns integer
language sql stable
set search_path = public, extensions
as $$
  select coalesce(
    nullif(current_setting('app.clipboard_max_file_bytes', true), ''),
    '6291456'
  )::integer;
$$;

-- Purge entries past their expiry (plus a 12h grace so a list cannot race an in-flight
-- download), and garbage-collect dead tokens / attempt rows. Returns rows deleted.
create or replace function app.clipboard_purge()
returns integer
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_deleted integer;
begin
  delete from public.clipboard_entry where expires_at < now() - interval '12 hours';
  get diagnostics v_deleted = row_count;
  delete from public.clipboard_token where expires_at < now() - interval '1 day';
  delete from public.clipboard_attempt where created_at < now() - interval '2 days';
  return v_deleted;
end;
$$;

-- Resolve the caller's shared-mode secret from the x-clipboard-token header.
-- Returns NULL when the header is missing, unknown, or expired.
create or replace function app.clipboard_auth()
returns bigint
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_raw text;
  v_sid bigint;
begin
  begin
    v_raw := btrim(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-clipboard-token', ''));
  exception when others then
    return null;
  end;

  if v_raw = '' then
    return null;
  end if;

  select secret_id into v_sid
    from public.clipboard_token
   where token_hash = encode(digest(v_raw, 'sha256'), 'hex')
     and expires_at > now();

  return v_sid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Exchange a password for a temporary token. Rate limited per password-bucket and
-- globally, so the allowlist cannot be brute-forced at line speed.
create or replace function public.clipboard_verify(
  p_password      text,
  p_ttl_seconds   integer default 3600
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_password text := coalesce(p_password, '');
  v_bucket   text;
  v_local    integer;
  v_global   integer;
  v_secret   record;
  v_token    text;
  v_ttl      integer := least(greatest(coalesce(p_ttl_seconds, 3600), 60), 86400);
  v_expires  timestamptz;
begin
  perform app.clipboard_purge();

  if v_password = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_password');
  end if;

  v_bucket := encode(digest(v_password || '|' || to_char(now(), 'YYYY-MM-DD'), 'sha256'), 'hex');

  select count(*) into v_local
    from public.clipboard_attempt
   where bucket = v_bucket
     and ok is false
     and created_at > now() - interval '15 minutes';

  select count(*) into v_global
    from public.clipboard_attempt
   where ok is false
     and created_at > now() - interval '5 minutes';

  if v_local >= 10 or v_global >= 120 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'retry_after_seconds', 900);
  end if;

  select id, label into v_secret
    from public.clipboard_secret
   -- Supabase's pgcrypto 1.3 returns text from crypt(), so compare digests rather than
   -- relying on the newer boolean signature.
   where crypt(v_password, pw_hash) = pw_hash
   order by id
   limit 1;

  if not found then
    insert into public.clipboard_attempt (bucket, ok) values (v_bucket, false);
    return jsonb_build_object('ok', false, 'error', 'invalid_password');
  end if;

  insert into public.clipboard_attempt (bucket, ok) values (v_bucket, true);

  v_token   := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(secs => v_ttl);

  insert into public.clipboard_token (token_hash, secret_id, expires_at)
    values (encode(digest(v_token, 'sha256'), 'hex'), v_secret.id, v_expires);

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'label', v_secret.label,
    'expires_at', v_expires
  );
end;
$$;

-- Metadata for the UI (counts, retention, expiry horizon). Also triggers a purge.
create or replace function public.clipboard_status()
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_out jsonb;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  perform app.clipboard_purge();

  select jsonb_build_object(
    'ok', true,
    'count', count(*),
    'bytes', coalesce(sum(octet_length(coalesce(body, '')) + octet_length(coalesce(data, ''))), 0),
    'oldest', min(created_at),
    'newest', max(created_at),
    'purged_before', min(expires_at),
    'retention_days', app.clipboard_retention_days(),
    'max_file_bytes', app.clipboard_max_file_bytes()
  ) into v_out
    from public.clipboard_entry;

  return v_out;
end;
$$;

-- List entries (metadata only; file bytes are fetched with clipboard_get).
-- volatile, not stable: the call also purges expired rows.
create or replace function public.clipboard_list(p_limit integer default 50)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_entries jsonb;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  perform app.clipboard_purge();

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'kind', e.kind,
    'title', e.title,
    'body', e.body,
    'file_name', e.file_name,
    'file_type', e.file_type,
    'file_size', e.file_size,
    'has_data', e.data is not null,
    'created_at', e.created_at,
    'expires_at', e.expires_at
  ) order by e.created_at desc), '[]'::jsonb) into v_entries
    from (
      select * from public.clipboard_entry
       order by created_at desc
       limit v_lim
    ) e;

  return jsonb_build_object('ok', true, 'entries', v_entries);
end;
$$;

-- Fetch one entry including (for files) base64 ciphertext + iv.
create or replace function public.clipboard_get(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_row record;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select * into v_row from public.clipboard_entry where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'entry', jsonb_build_object(
      'id', v_row.id,
      'kind', v_row.kind,
      'title', v_row.title,
      'body', v_row.body,
      'file_name', v_row.file_name,
      'file_type', v_row.file_type,
      'file_size', v_row.file_size,
      'iv', v_row.iv,
      'kdf_salt', v_row.kdf_salt,
      'data', case when v_row.data is not null then encode(v_row.data, 'base64') end,
      'created_at', v_row.created_at,
      'expires_at', v_row.expires_at
    )
  );
end;
$$;

-- Create an entry. p_data is base64 of the AES-GCM ciphertext, p_iv / p_salt the base64
-- IV and PBKDF2 salt the browser generated (files only).
-- The 7-argument overload existed before p_salt was introduced; drop it so PostgREST
-- never has to disambiguate between two matching signatures.
drop function if exists public.clipboard_put(text, text, text, text, text, text, text);
create or replace function public.clipboard_put(
  p_kind      text,
  p_body      text default null,
  p_title     text default '',
  p_file_name text default null,
  p_file_type text default null,
  p_data      text default null,
  p_iv        text default null,
  p_salt      text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_raw bytea;
  v_max integer := app.clipboard_max_file_bytes();
  v_row public.clipboard_entry%rowtype;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if v_kind not in ('text', 'file') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;

  if v_kind = 'text' then
    if p_body is null or btrim(p_body) = '' then
      return jsonb_build_object('ok', false, 'error', 'empty_text');
    end if;
    if octet_length(p_body) > 262144 then
      return jsonb_build_object('ok', false, 'error', 'text_too_large', 'max_bytes', 262144);
    end if;
  else
    if p_data is null or btrim(p_data) = '' or p_iv is null or btrim(p_iv) = '' or p_salt is null or btrim(p_salt) = '' then
      return jsonb_build_object('ok', false, 'error', 'empty_file');
    end if;
    begin
      v_raw := decode(p_data, 'base64');
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad_base64');
    end;
    if octet_length(v_raw) > v_max then
      return jsonb_build_object('ok', false, 'error', 'file_too_large', 'max_bytes', v_max);
    end if;
    if octet_length(coalesce(p_file_name, '')) > 512 then
      return jsonb_build_object('ok', false, 'error', 'file_name_too_long');
    end if;
  end if;

  insert into public.clipboard_entry (
    kind, title, body, file_name, file_type, file_size, data, iv, kdf_salt, expires_at
  ) values (
    v_kind,
    left(coalesce(p_title, ''), 200),
    case when v_kind = 'text' then p_body end,
    case when v_kind = 'file' then left(coalesce(p_file_name, 'clipboard.bin'), 200) end,
    coalesce(
      case when v_kind = 'file' then left(coalesce(nullif(btrim(p_file_type), ''), 'application/octet-stream'), 128) end,
      'application/octet-stream'
    ),
    case when v_kind = 'file' then octet_length(v_raw) else octet_length(p_body) end,
    case when v_kind = 'file' then v_raw end,
    case when v_kind = 'file' then left(btrim(p_iv), 64) end,
    case when v_kind = 'file' then left(btrim(p_salt), 64) end,
    now() + make_interval(days => app.clipboard_retention_days())
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'entry', jsonb_build_object(
    'id', v_row.id,
    'kind', v_row.kind,
    'title', v_row.title,
    'body', v_row.body,
    'file_name', v_row.file_name,
    'file_type', v_row.file_type,
    'file_size', v_row.file_size,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at
  ));
end;
$$;

-- Delete one entry (shared mode: any verified user may delete any entry).
create or replace function public.clipboard_delete(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_n integer;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  delete from public.clipboard_entry where id = p_id;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Wipe the whole shared clipboard. The "where id is not null" keeps Supabase's
-- safe-updates guard from rejecting a bare DELETE.
create or replace function public.clipboard_clear()
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_sid bigint;
  v_n integer;
begin
  v_sid := app.clipboard_auth();
  if v_sid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  delete from public.clipboard_entry where id is not null;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'deleted', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS with zero policies + no table grants. Only EXECUTE on the RPCs
-- is granted to anon/authenticated, and those functions are SECURITY DEFINER.
-- ---------------------------------------------------------------------------

alter table public.clipboard_secret  enable row level security;
alter table public.clipboard_attempt enable row level security;
alter table public.clipboard_token   enable row level security;
alter table public.clipboard_entry   enable row level security;

revoke all on public.clipboard_secret  from anon, authenticated;
revoke all on public.clipboard_attempt from anon, authenticated;
revoke all on public.clipboard_token   from anon, authenticated;
revoke all on public.clipboard_entry   from anon, authenticated;

grant usage on schema public, app to anon, authenticated, service_role;
alter function public.clipboard_verify(text, integer) owner to postgres;
alter function public.clipboard_status()               owner to postgres;
alter function public.clipboard_list(integer)          owner to postgres;
alter function public.clipboard_get(uuid)              owner to postgres;
alter function public.clipboard_put(text, text, text, text, text, text, text, text) owner to postgres;
alter function public.clipboard_delete(uuid)           owner to postgres;
alter function public.clipboard_clear()                owner to postgres;
alter function app.clipboard_auth()                    owner to postgres;
alter function app.clipboard_purge()                   owner to postgres;
alter function app.clipboard_retention_days()          owner to postgres;
alter function app.clipboard_max_file_bytes()          owner to postgres;

revoke all on function public.clipboard_verify(text, integer) from public;
revoke all on function public.clipboard_status()              from public;
revoke all on function public.clipboard_list(integer)         from public;
revoke all on function public.clipboard_get(uuid)             from public;
revoke all on function public.clipboard_put(text, text, text, text, text, text, text, text) from public;
revoke all on function public.clipboard_delete(uuid)          from public;
revoke all on function public.clipboard_clear()               from public;

grant execute on function public.clipboard_verify(text, integer) to anon, authenticated, service_role;
grant execute on function public.clipboard_status()              to anon, authenticated, service_role;
grant execute on function public.clipboard_list(integer)         to anon, authenticated, service_role;
grant execute on function public.clipboard_get(uuid)             to anon, authenticated, service_role;
grant execute on function public.clipboard_put(text, text, text, text, text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.clipboard_delete(uuid)          to anon, authenticated, service_role;
grant execute on function public.clipboard_clear()               to anon, authenticated, service_role;
