-- Tools toolbox — DeepSeek credential store + conversation sessions.
--
-- Two changes on top of 0002:
--
-- 1. Credential in the database instead of in Edge Function secrets. The DeepSeek web login
--    (localStorage.userToken) expires, and rotating a Supabase secret means a redeploy. The
--    operator pastes one string into the hidden admin page (or runs scripts/deepseek-credential.mjs),
--    the Edge Function parses it, and it is live on the next request. Only service_role can
--    read the token itself; anon sees a coarse status.
--
-- 2. Sessions. DeepSeek's web API is conversation-based: a turn carries chat_session_id plus
--    the previous turn's response_message_id, and DeepSeek keeps the context server-side. So a
--    job now stores those ids and hands them back, which is what lets the UI continue the same
--    conversation or start a new one. (Session *management* — listing, renaming, switching —
--    is deliberately out of scope; the client keeps exactly one active session.)

-- ---------------------------------------------------------------------------
-- 1. Credential
-- ---------------------------------------------------------------------------

create table if not exists public.deepseek_credential (
  id          smallint primary key default 1 check (id = 1),
  token       text not null,
  device_id   text,
  cookie      text,
  user_agent  text,
  source      text,
  note        text,
  updated_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  last_error  text
);
comment on table public.deepseek_credential is
  'The single DeepSeek web credential the relay uses. Token is a bearer secret: service_role only.';

alter table public.deepseek_credential enable row level security;
-- No policies on purpose: RLS denies anon/authenticated every row, so the token can only be
-- reached through the RPCs below (or the dashboard).
drop policy if exists deepseek_credential_service on public.deepseek_credential;

revoke all on public.deepseek_credential from anon, authenticated;
grant select on public.deepseek_credential to service_role;

-- Store a freshly parsed credential. Called by scripts/deepseek-credential.mjs (service role)
-- and by the deepseek-chat Edge Function after it has checked the admin token.
create or replace function public.deepseek_credential_set(
  p_token       text,
  p_device_id   text default null,
  p_cookie      text default null,
  p_user_agent  text default null,
  p_source      text default null,
  p_note        text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
begin
  if char_length(v_token) < 20 or v_token ~ '\s' then
    return jsonb_build_object('ok', false, 'error', 'bad_token', 'length', char_length(v_token));
  end if;

  insert into public.deepseek_credential
      (id, token, device_id, cookie, user_agent, source, note, updated_at, last_error)
  values
      (1, v_token, nullif(btrim(coalesce(p_device_id, '')), ''),
          nullif(btrim(coalesce(p_cookie, '')), ''),
          nullif(btrim(coalesce(p_user_agent, '')), ''),
          left(coalesce(nullif(btrim(p_source), ''), 'unknown'), 32),
          left(coalesce(nullif(btrim(p_note), ''), ''), 200),
          now(), null)
  on conflict (id) do update
     set token = excluded.token,
         device_id = excluded.device_id,
         cookie = excluded.cookie,
         user_agent = excluded.user_agent,
         source = excluded.source,
         note = excluded.note,
         updated_at = now(),
         last_error = null;

  return jsonb_build_object('ok', true, 'updated_at', now(), 'token_length', char_length(v_token));
end;
$$;

-- Full credential for the relay. service_role only.
create or replace function public.deepseek_credential_get()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v public.deepseek_credential%rowtype;
begin
  select * into v from public.deepseek_credential where id = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_configured');
  end if;
  return jsonb_build_object(
    'ok', true,
    'token', v.token,
    'device_id', coalesce(v.device_id, ''),
    'cookie', coalesce(v.cookie, ''),
    'user_agent', coalesce(v.user_agent, ''),
    'source', coalesce(v.source, ''),
    'updated_at', v.updated_at,
    'last_ok_at', v.last_ok_at,
    'last_error', v.last_error
  );
end;
$$;

-- Coarse status: safe to show in the UI. Reports a 4-character hint, never the token.
create or replace function public.deepseek_credential_status()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v public.deepseek_credential%rowtype;
begin
  select * into v from public.deepseek_credential where id = 1;
  if not found then
    return jsonb_build_object('ok', true, 'configured', false);
  end if;
  return jsonb_build_object(
    'ok', true,
    'configured', true,
    'token_hint', left(v.token, 4) || '…' || char_length(v.token),
    'has_device_id', v.device_id is not null,
    'has_cookie', v.cookie is not null,
    'source', coalesce(v.source, ''),
    'note', coalesce(v.note, ''),
    'updated_at', v.updated_at,
    'age_minutes', round(extract(epoch from (now() - v.updated_at)) / 60.0)::int,
    'last_ok_at', v.last_ok_at,
    'last_error', v.last_error
  );
end;
$$;

-- The relay records whether the credential actually worked, so expiry is visible before the
-- UI starts erroring. p_ok = false keeps the previous last_ok_at.
create or replace function public.deepseek_credential_report(p_ok boolean, p_error text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from public.deepseek_credential where id = 1) then
    return jsonb_build_object('ok', false, 'error', 'not_configured');
  end if;
  update public.deepseek_credential
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         last_error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'unknown error'), 300) end
   where id = 1;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Sessions
-- ---------------------------------------------------------------------------

alter table public.deepseek_job add column if not exists prompt            text;
alter table public.deepseek_job add column if not exists session_id        text;
alter table public.deepseek_job add column if not exists parent_message_id bigint;
alter table public.deepseek_job add column if not exists reply_message_id  bigint;
alter table public.deepseek_job add column if not exists model_type        text not null default 'default';
alter table public.deepseek_job add column if not exists thinking_enabled  boolean not null default false;
alter table public.deepseek_job add column if not exists search_enabled    boolean not null default false;
alter table public.deepseek_job add column if not exists title             text;

-- messages stays for the transcript the client sends, but a session turn only needs the prompt.
alter table public.deepseek_job alter column messages set default '[]'::jsonb;

comment on column public.deepseek_job.session_id is
  'DeepSeek chat_session_id. Null means "start a new conversation"; the relay fills it in.';
comment on column public.deepseek_job.reply_message_id is
  'The response_message_id DeepSeek assigned — the parent_message_id for the next turn.';

create or replace function public.deepseek_ask(
  p_prompt           text,
  p_session_id       text default null,
  p_parent_message_id bigint default null,
  p_model_type       text default 'default',
  p_thinking         boolean default false,
  p_search           boolean default false,
  p_messages         jsonb default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_recent  integer;
  v_pending integer;
  v_id      uuid;
  v_prompt  text := btrim(coalesce(p_prompt, ''));
  v_model   text := coalesce(nullif(btrim(p_model_type), ''), 'default');
begin
  perform app.deepseek_purge();

  if v_prompt = '' then
    return jsonb_build_object('ok', false, 'error', 'empty_prompt');
  end if;
  if octet_length(v_prompt) > 32768 then
    return jsonb_build_object('ok', false, 'error', 'prompt_too_long', 'max', 32768);
  end if;
  if v_model not in ('default', 'expert', 'vision') then
    return jsonb_build_object('ok', false, 'error', 'bad_model_type', 'allowed', 'default,expert,vision');
  end if;
  if p_session_id is not null and char_length(p_session_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'bad_session_id');
  end if;
  if p_messages is not null and jsonb_typeof(p_messages) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_messages');
  end if;

  select count(*) into v_recent
    from public.deepseek_job
   where created_at > now() - interval '1 minute';

  select count(*) into v_pending
    from public.deepseek_job
   where status in ('queued', 'claimed', 'streaming');

  if v_recent >= 20 or v_pending >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'retry_after_seconds', 60);
  end if;

  insert into public.deepseek_job
      (model, model_type, prompt, session_id, parent_message_id, thinking_enabled, search_enabled, messages)
  values
      (v_model, v_model, v_prompt,
       nullif(btrim(coalesce(p_session_id, '')), ''),
       p_parent_message_id,
       coalesce(p_thinking, false),
       coalesce(p_search, false),
       coalesce(p_messages, jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_prompt))))
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_id,
    'status', 'queued',
    'session_id', nullif(btrim(coalesce(p_session_id, '')), ''),
    'expires_at', (now() + interval '1 hour')
  );
end;
$$;

-- Progress poll. Now also returns the session ids, so a client that only polls can still
-- continue the conversation after a reload.
create or replace function public.deepseek_status(
  p_job_id    uuid,
  p_since_seq integer default -1
)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_job    record;
  v_chunks jsonb;
begin
  select * into v_job from public.deepseek_job where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'payload', c.payload, 'created_at', c.created_at)
                            order by c.seq), '[]'::jsonb)
    into v_chunks
    from public.deepseek_chunk c
   where c.job_id = p_job_id
     and c.seq > coalesce(p_since_seq, -1);

  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'status', v_job.status,
    'transport', v_job.transport,
    'metrics', v_job.metrics,
    'error', v_job.error,
    'chunks', v_chunks,
    'prompt', v_job.prompt,
    'session_id', v_job.session_id,
    'parent_message_id', v_job.parent_message_id::text,
    'reply_message_id', v_job.reply_message_id::text,
    'title', v_job.title,
    'model_type', v_job.model_type,
    'thinking_enabled', v_job.thinking_enabled,
    'search_enabled', v_job.search_enabled,
    'finished', v_job.status in ('done', 'error', 'cancelled')
  );
end;
$$;

-- Claim now hands the whole turn description to the transport.
create or replace function public.deepseek_claim(p_worker_id text, p_job_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_job public.deepseek_job%rowtype;
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 64);
begin
  if v_worker = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_worker_id');
  end if;

  perform app.deepseek_purge();

  update public.deepseek_job
     set claimed_at = now()
   where id = (
     select id from public.deepseek_job
      where worker_id = v_worker and status in ('claimed', 'streaming')
      order by claimed_at desc nulls last limit 1
   );

  if p_job_id is not null then
    select * into v_job
      from public.deepseek_job
     where id = p_job_id
       and (status = 'queued' or (status in ('claimed', 'streaming') and worker_id = v_worker))
     for update skip locked;

    if not found then
      return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'not_available');
    end if;
  else
    select * into v_job
      from public.deepseek_job
     where status = 'queued'
     order by created_at
     limit 1
     for update skip locked;

    if not found then
      return jsonb_build_object('ok', true, 'claimed', false);
    end if;
  end if;

  update public.deepseek_job
     set status = 'claimed',
         worker_id = v_worker,
         claimed_at = now(),
         metrics = metrics || jsonb_build_object('claimed_at', now())
   where id = v_job.id;

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'job_id', v_job.id,
    'model', v_job.model,
    'model_type', v_job.model_type,
    'messages', v_job.messages,
    'prompt', v_job.prompt,
    'session_id', v_job.session_id,
    'parent_message_id', v_job.parent_message_id::text,
    'thinking_enabled', v_job.thinking_enabled,
    'search_enabled', v_job.search_enabled
  );
end;
$$;

-- Finish a job, recording the ids the next turn needs.
create or replace function public.deepseek_complete(
  p_job_id           uuid,
  p_ok               boolean default true,
  p_error            text default null,
  p_metrics          jsonb default '{}'::jsonb,
  p_session_id       text default null,
  p_reply_message_id bigint default null,
  p_title            text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_job public.deepseek_job%rowtype;
begin
  select * into v_job from public.deepseek_job where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  update public.deepseek_job
     set status = case when p_ok then 'done' else 'error' end,
         error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'upstream error'), 500) end,
         finished_at = now(),
         session_id = coalesce(nullif(btrim(coalesce(p_session_id, '')), ''), session_id),
         reply_message_id = coalesce(p_reply_message_id, reply_message_id),
         title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title),
         metrics = metrics || coalesce(p_metrics, '{}'::jsonb) || jsonb_build_object('finished_at', now())
   where id = p_job_id
   returning * into v_job;

  return jsonb_build_object(
    'ok', true,
    'status', v_job.status,
    'metrics', v_job.metrics,
    'session_id', v_job.session_id,
    'reply_message_id', v_job.reply_message_id::text
  );
end;
$$;

-- Health now reports the credential too, so the UI can say "登录已过期" instead of a raw error.
create or replace function public.deepseek_health()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_out jsonb;
  v_credential jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'pending', count(*) filter (where status in ('queued', 'claimed', 'streaming')),
    'queued', count(*) filter (where status = 'queued'),
    'workers_alive', count(distinct worker_id) filter (
      where worker_id is not null and coalesce(claimed_at, created_at) > now() - interval '30 seconds'
    ),
    'done_last_hour', count(*) filter (where status = 'done' and created_at > now() - interval '1 hour'),
    'error_last_hour', count(*) filter (where status = 'error' and created_at > now() - interval '1 hour'),
    'median_ttft_ms', (
      select round(percentile_cont(0.5) within group (order by (m ->> 'upstream_ttft_ms')::numeric))::int
        from (
          select metrics as m
            from public.deepseek_job
           where created_at > now() - interval '1 hour'
             and metrics ? 'upstream_ttft_ms'
        ) s
    )
  ) into v_out from public.deepseek_job
   where created_at > now() - interval '1 hour';

  select deepseek_credential_status() into v_credential;
  v_out := v_out || jsonb_build_object(
    'credential_configured', coalesce((v_credential ->> 'configured')::boolean, false),
    'credential_age_minutes', coalesce(v_credential ->> 'age_minutes', ''),
    'credential_error', coalesce(v_credential ->> 'last_error', '')
  );
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants + ownership
-- ---------------------------------------------------------------------------

alter function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb)              owner to postgres;
alter function public.deepseek_status(uuid, integer)                                               owner to postgres;
alter function public.deepseek_claim(text, uuid)                                                  owner to postgres;
alter function public.deepseek_complete(uuid, boolean, text, jsonb, text, bigint, text)            owner to postgres;
alter function public.deepseek_health()                                                            owner to postgres;
alter function public.deepseek_credential_set(text, text, text, text, text, text)                  owner to postgres;
alter function public.deepseek_credential_get()                                                    owner to postgres;
alter function public.deepseek_credential_status()                                                 owner to postgres;
alter function public.deepseek_credential_report(boolean, text)                                    owner to postgres;

revoke all on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb)              from public;
revoke all on function public.deepseek_status(uuid, integer)                                              from public;
revoke all on function public.deepseek_claim(text, uuid)                                                 from public;
revoke all on function public.deepseek_complete(uuid, boolean, text, jsonb, text, bigint, text)            from public;
revoke all on function public.deepseek_health()                                                          from public;
revoke all on function public.deepseek_credential_set(text, text, text, text, text, text)                from public;
revoke all on function public.deepseek_credential_get()                                                  from public;
revoke all on function public.deepseek_credential_status()                                               from public;
revoke all on function public.deepseek_credential_report(boolean, text)                                  from public;

grant execute on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb)     to anon, authenticated, service_role;
grant execute on function public.deepseek_status(uuid, integer)                                       to anon, authenticated, service_role;
grant execute on function public.deepseek_claim(text, uuid)                                           to anon, authenticated, service_role;
grant execute on function public.deepseek_complete(uuid, boolean, text, jsonb, text, bigint, text)    to anon, authenticated, service_role;
grant execute on function public.deepseek_health()                                                    to anon, authenticated, service_role;
grant execute on function public.deepseek_credential_status()                                         to anon, authenticated, service_role;

-- The token itself never leaves the service_role path. Supabase grants EXECUTE to anon and
-- authenticated through schema-wide default privileges, so revoking from PUBLIC is not
-- enough — name the roles explicitly.
revoke execute on function public.deepseek_credential_set(text, text, text, text, text, text) from anon, authenticated;
revoke execute on function public.deepseek_credential_get()                                            from anon, authenticated;
revoke execute on function public.deepseek_credential_report(boolean, text)                            from anon, authenticated;
grant execute on function public.deepseek_credential_set(text, text, text, text, text, text)         to service_role;
grant execute on function public.deepseek_credential_get()                                            to service_role;
grant execute on function public.deepseek_credential_report(boolean, text)                            to service_role;

-- The OpenAI-shaped enqueue from 0002 is gone: the web protocol is conversation-based, and
-- replaying a whole message array every turn was both wasteful and not what DeepSeek does.
drop function if exists public.deepseek_enqueue(jsonb, text);
