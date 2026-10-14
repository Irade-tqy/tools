-- 0006 — named queues.
--
-- Why: with a production relay serving the live project, every test that queues a fake turn
-- races that relay for the job — the relay grabs it, calls DeepSeek with a throwaway token and
-- completes it as an error, so the test's own claim assertions fail. Queues separate them:
-- the relay serves 'default', the test suites claim from 'test', and health only reports the
-- queue the public site actually uses.

alter table public.deepseek_job add column if not exists queue text not null default 'default';
comment on column public.deepseek_job.queue is
  'Which relay serves this job: default = production, anything else = a test or staging relay.';

create index if not exists deepseek_job_queue_idx
  on public.deepseek_job (queue, status, created_at)
  where status in ('queued', 'claimed', 'streaming');

-- Queue a turn. p_queue defaults to 'default', so the public client never passes it.
create or replace function public.deepseek_ask(
  p_prompt            text,
  p_session_id        text default null,
  p_parent_message_id bigint default null,
  p_model_type        text default 'default',
  p_thinking          boolean default false,
  p_search            boolean default false,
  p_messages          jsonb default null,
  p_queue             text default 'default'
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_id     uuid;
  v_recent integer;
  v_pending integer;
  v_model  text := coalesce(nullif(btrim(p_model_type), ''), 'default');
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_queue  text := left(btrim(coalesce(nullif(p_queue, ''), 'default')), 32);
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
      (model, model_type, prompt, session_id, parent_message_id, thinking_enabled, search_enabled, messages, queue)
  values
      (v_model, v_model, v_prompt,
       nullif(btrim(coalesce(p_session_id, '')), ''),
       p_parent_message_id,
       coalesce(p_thinking, false),
       coalesce(p_search, false),
       coalesce(p_messages, jsonb_build_array(jsonb_build_object('role', 'user', 'content', v_prompt))),
       v_queue)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_id,
    'status', 'queued',
    'queue', v_queue,
    'session_id', nullif(btrim(coalesce(p_session_id, '')), ''),
    'expires_at', (now() + interval '1 hour')
  );
end;
$$;

-- Claim. p_queue null means "any queue" (the drain helpers and a single relay that serves
-- everything); a relay normally passes its own so it never eats another queue's work.
create or replace function public.deepseek_claim(
  p_worker_id text,
  p_job_id    uuid default null,
  p_queue     text default null
)
returns jsonb
language plpgsql volatile security definer
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
    'search_enabled', v_job.search_enabled
  );
end;
$$;

-- Health describes the queue visitors use; a test queue backlog must not turn the status
-- strip red on the public site.
create or replace function public.deepseek_health()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_out jsonb;
  v_credential jsonb;
  v_workers jsonb;
  v_alive integer;
begin
  select jsonb_build_object(
    'ok', true,
    'pending', count(*) filter (where status in ('queued', 'claimed', 'streaming')),
    'queued', count(*) filter (where status = 'queued'),
    'done_last_hour', count(*) filter (where status = 'done' and created_at > now() - interval '1 hour'),
    'error_last_hour', count(*) filter (where status = 'error' and created_at > now() - interval '1 hour'),
    'median_ttft_ms', (
      select round(percentile_cont(0.5) within group (order by (m ->> 'upstream_ttft_ms')::numeric))::int
        from (
          select metrics as m
            from public.deepseek_job
           where queue = 'default'
             and created_at > now() - interval '1 hour'
             and metrics ? 'upstream_ttft_ms'
        ) s
    )
  ) into v_out from public.deepseek_job
   where queue = 'default' and created_at > now() - interval '1 hour';

  select coalesce(jsonb_agg(jsonb_build_object(
           'worker_id', w.worker_id,
           'kind', w.kind,
           'turns', w.turns,
           'seen_at', w.seen_at,
           'age_seconds', round(extract(epoch from (now() - w.seen_at)))::int
         ) order by w.seen_at desc), '[]'::jsonb),
         count(*) filter (where w.seen_at > now() - interval '30 seconds')
    into v_workers, v_alive
    from (
      select worker_id, kind, turns, seen_at
        from public.deepseek_worker
       where seen_at > now() - interval '5 minutes'
       order by seen_at desc
       limit 20
    ) w;

  v_out := v_out || jsonb_build_object(
    'workers_alive', v_alive,
    'workers', v_workers,
    'workers_claiming', (
      select count(distinct worker_id)
        from public.deepseek_job
       where queue = 'default'
         and worker_id is not null
         and status in ('claimed', 'streaming')
         and coalesce(claimed_at, created_at) > now() - interval '30 seconds'
    )
  );

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
-- grants + ownership
-- ---------------------------------------------------------------------------

alter function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text) owner to postgres;
alter function public.deepseek_claim(text, uuid, text)                                       owner to postgres;
alter function public.deepseek_health()                                                      owner to postgres;

revoke all on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text) from public;
revoke all on function public.deepseek_claim(text, uuid, text)                                from public;
revoke all on function public.deepseek_health()                                               from public;

grant execute on function public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb, text)
  to anon, authenticated, service_role;
grant execute on function public.deepseek_claim(text, uuid, text)   to anon, authenticated, service_role;
grant execute on function public.deepseek_health()                  to anon, authenticated, service_role;

-- Supabase's default privileges hand EXECUTE to anon/authenticated explicitly, so revoking
-- from PUBLIC alone is not enough for a service-role-only RPC.
revoke all on function public.tools_secret_set(text, text, text) from public, anon, authenticated;
grant execute on function public.tools_secret_set(text, text, text) to service_role;
