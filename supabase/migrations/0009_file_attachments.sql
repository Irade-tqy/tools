-- 0009 — file attachments.
--
-- DeepSeek's web app uploads a file to /api/v0/file/upload_file, gets back an id like
-- `file-<uuid>`, waits for upstream to finish parsing it, and then references that id in the
-- completion body as `ref_file_ids`. The bytes never reach the completion call, so the queue only
-- has to carry the ids: the browser uploads through the Edge Function (which holds the DeepSeek
-- credential), queues the turn with the ids, and either transport passes them straight upstream.

alter table public.deepseek_job
  add column if not exists file_ids jsonb not null default '[]'::jsonb;

-- Upstream ids are `file-` + a uuid. Rejecting anything else at enqueue time means a typo or a
-- forged id fails with a clear error instead of surfacing as an opaque upstream rejection one
-- turn later. A CHECK cannot contain a subquery, so the constraint holds what it can (an array,
-- at most 5 entries) and deepseek_ask validates every element.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'deepseek_job_file_ids_shape'
  ) then
    alter table public.deepseek_job
      add constraint deepseek_job_file_ids_shape
      check (jsonb_typeof(file_ids) = 'array' and jsonb_array_length(file_ids) <= 5);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- deepseek_ask: one extra parameter. Dropping the old signature first keeps the
-- "no RPC may be overloaded" invariant 0007 established.
-- ---------------------------------------------------------------------------
drop function if exists public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text);

create or replace function public.deepseek_ask(
  p_prompt            text,
  p_session_id        text    default null,
  p_parent_message_id bigint  default null,
  p_model_type        text    default 'default',
  p_thinking          boolean default false,
  p_search            boolean default false,
  p_messages          jsonb   default null,
  p_queue             text    default 'default',
  p_file_ids          jsonb   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id     uuid;
  v_recent integer;
  v_pending integer;
  v_model  text := coalesce(nullif(btrim(p_model_type), ''), 'default');
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_queue  text := left(btrim(coalesce(nullif(p_queue, ''), 'default')), 32);
  v_files  jsonb := coalesce(p_file_ids, '[]'::jsonb);
begin
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
  if jsonb_typeof(v_files) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_file_ids');
  end if;
  if jsonb_array_length(v_files) > 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_files', 'max', 5);
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_files) as e
     where jsonb_typeof(e) <> 'string'
        or e #>> '{}' !~ '^file-[0-9a-f-]{8,64}$'
  ) then
    return jsonb_build_object('ok', false, 'error', 'bad_file_id');
  end if;

  -- Rate limits are per queue: a test run must not starve the public site (or vice versa).
  select count(*) into v_recent
    from public.deepseek_job
   where queue = v_queue and created_at > now() - interval '1 minute';

  select count(*) into v_pending
    from public.deepseek_job
   where queue = v_queue and status in ('queued', 'claimed', 'streaming');

  if v_recent >= 20 or v_pending >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'retry_after_seconds', 60);
  end if;

  insert into public.deepseek_job
      (model, model_type, prompt, session_id, parent_message_id, thinking_enabled, search_enabled, messages, queue, file_ids)
  values
      (v_model, v_model, v_prompt,
       nullif(btrim(coalesce(p_session_id, '')), ''),
       p_parent_message_id,
       coalesce(p_thinking, false),
       coalesce(p_search, false),
       coalesce(p_messages, jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_prompt))),
       v_queue,
       v_files)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_id,
    'status', 'queued',
    'queue', v_queue,
    'session_id', nullif(btrim(coalesce(p_session_id, '')), ''),
    'file_ids', v_files,
    'expires_at', (now() + interval '1 hour')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- deepseek_claim / deepseek_status: same signatures, one extra output key, so a
-- transport can pass the ids upstream and a reloaded page can still show what it
-- attached.
-- ---------------------------------------------------------------------------
create or replace function public.deepseek_claim(
  p_worker_id text,
  p_job_id    uuid default null,
  p_queue     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job    public.deepseek_job%rowtype;
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 64);
  v_queue  text := nullif(left(btrim(coalesce(p_queue, '')), 32), '');
begin
  if v_worker = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_worker_id');
  end if;

  perform app.deepseek_purge();

  insert into public.deepseek_worker as w (worker_id, kind, seen_at)
       values (v_worker, 'relay', now())
  on conflict (worker_id) do update set seen_at = now();

  if p_job_id is not null then
    select * into v_job
      from public.deepseek_job
     where id = p_job_id
       and (v_queue is null or queue = v_queue)
       and (status = 'queued' or (status in ('claimed', 'streaming') and worker_id = v_worker))
     for update skip locked;

    if not found then
      return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'not_available');
    end if;
  else
    select * into v_job
      from public.deepseek_job
     where status = 'queued'
       and (v_queue is null or queue = v_queue)
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

  update public.deepseek_worker
     set turns = turns + 1, seen_at = now()
   where worker_id = v_worker;

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'job_id', v_job.id,
    'queue', v_job.queue,
    'model', v_job.model,
    'model_type', v_job.model_type,
    'messages', v_job.messages,
    'prompt', v_job.prompt,
    'session_id', v_job.session_id,
    'parent_message_id', v_job.parent_message_id::text,
    'thinking_enabled', v_job.thinking_enabled,
    'search_enabled', v_job.search_enabled,
    'file_ids', v_job.file_ids
  );
end;
$$;

create or replace function public.deepseek_status(
  p_job_id    uuid,
  p_since_seq integer default -1
)
returns jsonb
language plpgsql
stable
security definer
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
    'file_ids', coalesce(v_job.file_ids, '[]'::jsonb),
    'finished', v_job.status in ('done', 'error', 'cancelled')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- grants + ownership: deepseek_ask was dropped and recreated, so its grants are new.
-- ---------------------------------------------------------------------------
alter function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text, jsonb) owner to postgres;

revoke all on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text, jsonb) from public;
grant execute on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text, jsonb)
  to anon, authenticated, service_role;
