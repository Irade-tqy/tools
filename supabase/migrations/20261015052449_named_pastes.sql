-- Separate named documents; the shared clipboard and all chat RPCs stay compatible.
create table app.paste_document (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 15),
  body text not null default '' check (octet_length(body) <= 262144),
  mode text not null default 'public' check (mode in ('public', 'write_password', 'private')),
  password_hash text,
  revision bigint not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode = 'public' or password_hash is not null)
);
create index paste_document_creation on app.paste_document (created_by, created_at);
create table app.paste_access (
  token_hash text primary key,
  document_id uuid not null references app.paste_document on delete cascade,
  expires_at timestamptz not null default now() + interval '12 hours'
);
create table app.paste_attempt (
  document_id uuid not null references app.paste_document on delete cascade,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index paste_attempt_bucket on app.paste_attempt (document_id, bucket, created_at);
alter table app.paste_document enable row level security;
alter table app.paste_access enable row level security;
alter table app.paste_attempt enable row level security;
revoke all on app.paste_document, app.paste_access, app.paste_attempt from public, anon, authenticated;

create function app.paste_authorized(p_id uuid, p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.paste_access
    where document_id = p_id and expires_at > now()
      and token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;
revoke all on function app.paste_authorized(uuid, text) from public, anon, authenticated;

-- The private implementation owns password authorization; no table is exposed to anon.
create function app.paste_rpc(
  p_action text, p_id uuid, p_name text, p_body text,
  p_mode text, p_password text, p_token text, p_revision bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d app.paste_document;
  authorized boolean;
  readable boolean;
  writable boolean;
  issued_token text;
  v_bucket text;
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
begin
  v_bucket := encode(extensions.digest(coalesce(headers->>'x-real-ip', headers->>'x-forwarded-for', 'unknown'), 'sha256'), 'hex');
  if p_action = 'exists' then
    return jsonb_build_object('ok', true, 'exists', exists(select 1 from app.paste_document where name = p_name and id is distinct from p_id));
  end if;
  if p_action = 'create' then
    perform pg_advisory_xact_lock(hashtextextended(v_bucket, 7));
    if (select count(*) from app.paste_document where created_by = v_bucket and created_at > now() - interval '1 minute') >= 20 then
      return jsonb_build_object('ok', false, 'error', 'rate_limited');
    end if;
    insert into app.paste_document (name, created_by)
      values (substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12), v_bucket) returning * into d;
  else
    select * into d from app.paste_document
      where (p_id is not null and id = p_id) or (p_id is null and name = p_name)
      for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  authorized := app.paste_authorized(d.id, p_token);
  writable := d.mode = 'public' or authorized;
  if p_action = 'unlock' then
    delete from app.paste_attempt where created_at < now() - interval '1 day';
    delete from app.paste_access where expires_at < now();
    if (select count(*) from app.paste_attempt where document_id = d.id and bucket = v_bucket and created_at > now() - interval '5 minutes') >= 20 then
      return jsonb_build_object('ok', false, 'error', 'rate_limited');
    end if;
    if d.password_hash is null or p_password is null or d.password_hash <> extensions.crypt(encode(extensions.digest(p_password, 'sha256'), 'hex'), d.password_hash) then
      insert into app.paste_attempt (document_id, bucket) values (d.id, v_bucket);
      return jsonb_build_object('ok', false, 'error', 'invalid_password');
    end if;
    delete from app.paste_attempt where document_id = d.id and bucket = v_bucket;
    authorized := true;
    issued_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into app.paste_access (token_hash, document_id)
      values (encode(extensions.digest(issued_token, 'sha256'), 'hex'), d.id);
  elsif p_action in ('save', 'rename', 'mode', 'set_password') then
    if not writable then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
    if p_revision is distinct from d.revision then return jsonb_build_object('ok', false, 'error', 'conflict'); end if;
    if p_action = 'save' then
      if p_body is null or octet_length(p_body) > 262144 then return jsonb_build_object('ok', false, 'error', 'text_too_large'); end if;
      update app.paste_document set body = p_body where id = d.id;
    elsif p_action = 'rename' then
      if p_name is null or char_length(p_name) not between 1 and 15 then return jsonb_build_object('ok', false, 'error', 'invalid_name'); end if;
      begin
        update app.paste_document set name = p_name where id = d.id;
      exception when unique_violation then
        return jsonb_build_object('ok', false, 'error', 'name_exists');
      end;
    else
      if p_mode is null or p_mode not in ('public', 'write_password', 'private') then return jsonb_build_object('ok', false, 'error', 'invalid_mode'); end if;
      if p_action = 'set_password' then
        if d.password_hash is not null then return jsonb_build_object('ok', false, 'error', 'password_already_set'); end if;
        if coalesce(p_password, '') = '' then return jsonb_build_object('ok', false, 'error', 'empty_password'); end if;
        update app.paste_document set password_hash = extensions.crypt(encode(extensions.digest(p_password, 'sha256'), 'hex'), extensions.gen_salt('bf')) where id = d.id;
        issued_token := encode(extensions.gen_random_bytes(32), 'hex');
        insert into app.paste_access (token_hash, document_id)
          values (encode(extensions.digest(issued_token, 'sha256'), 'hex'), d.id);
        authorized := true;
      elsif p_mode <> 'public' and d.password_hash is null then
        return jsonb_build_object('ok', false, 'error', 'password_required');
      end if;
      update app.paste_document set mode = p_mode where id = d.id;
    end if;
    update app.paste_document set revision = revision + 1, updated_at = now() where id = d.id returning * into d;
  elsif p_action not in ('read', 'create') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
  end if;
  writable := d.mode = 'public' or authorized;
  readable := d.mode <> 'private' or authorized;
  return jsonb_build_object(
    'ok', true, 'id', d.id, 'name', d.name, 'mode', d.mode,
    'has_password', d.password_hash is not null, 'revision', d.revision,
    'can_read', readable, 'can_write', writable,
    'body', case when readable then d.body else null end,
    'token', issued_token
  );
end;
$$;
revoke all on function app.paste_rpc(text, uuid, text, text, text, text, text, bigint) from public;
grant usage on schema app to anon, authenticated;
grant execute on function app.paste_rpc(text, uuid, text, text, text, text, text, bigint) to anon, authenticated;

create function public.paste_document(
  p_action text, p_id uuid default null, p_name text default null,
  p_body text default null, p_mode text default null, p_password text default null,
  p_token text default null, p_revision bigint default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select app.paste_rpc(p_action, p_id, p_name, p_body, p_mode, p_password, p_token, p_revision);
$$;
revoke all on function public.paste_document(text, uuid, text, text, text, text, text, bigint) from public;
grant execute on function public.paste_document(text, uuid, text, text, text, text, text, bigint) to anon, authenticated;

-- Public image hosting matches shsfdy2sq. Uploads require edit access to the document.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('tools-images', 'tools-images', true, 5242880, array['image/webp'])
  on conflict (id) do nothing;
create function app.paste_image_write(p_path text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  d app.paste_document;
  token text;
begin
  select * into d from app.paste_document where id::text = split_part(p_path, '/', 1);
  if not found then return false; end if;
  token := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb->>'x-clipboard-token';
  return d.mode = 'public' or app.paste_authorized(d.id, token);
end;
$$;
revoke all on function app.paste_image_write(text) from public;
grant execute on function app.paste_image_write(text) to anon, authenticated;
create policy tools_images_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'tools-images' and app.paste_image_write(name));
notify pgrst, 'reload schema';
