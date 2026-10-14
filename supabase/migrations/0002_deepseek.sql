-- Tools toolbox — DeepSeek chat relay.
--
-- One job table, two interchangeable transports, both feeding the same rows:
--   1. Edge Function `deepseek-chat` (server-side, uses a cookie/API key kept in
--      Supabase secrets — never in this repo).
--   2. Browser worker: a tab that is already logged in to DeepSeek runs
--      public/deepseek-worker.js, claims queued jobs over PostgREST, calls DeepSeek
--      same-origin (so the login cookie works) and streams chunks back.
--
-- The UI enqueues a job, then watches deepseek_chunk / deepseek_job through Realtime
-- (with a polling fallback). Metrics are recorded per job so the "added latency vs the
-- official site" target can be measured instead of guessed.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.deepseek_job (
  id          uuid primary key default gen_random_uuid(),
  status      text not null default 'queued'
              check (status in ('queued', 'claimed', 'streaming', 'done', 'error', 'cancelled')),
  model       text not null default 'deepseek-chat',
  messages    jsonb not null check (jsonb_typeof(messages) = 'array'),
  metrics     jsonb not null default '{}'::jsonb,
  error       text,
  worker_id   text,
  transport   text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  finished_at timestamptz,
  expires_at  timestamptz not null default now() + interval '1 hour'
);
comment on table public.deepseek_job is 'One DeepSeek completion request, claimed by an edge function or a logged-in browser tab.';
create index if not exists deepseek_job_queue_idx on public.deepseek_job (status, created_at) where status in ('queued', 'claimed', 'streaming');
create index if not exists deepseek_job_expires_idx on public.deepseek_job (expires_at);

create table if not exists public.deepseek_chunk (
  job_id     uuid not null references public.deepseek_job (id) on delete cascade,
  seq        integer not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  primary key (job_id, seq)
);
comment on table public.deepseek_chunk is 'Streamed deltas for a job, in order. payload is the upstream chunk object, verbatim.';
create index if not exists deepseek_chunk_created_idx on public.deepseek_chunk (created_at);

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function app.deepseek_purge()
returns integer
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_deleted integer;
begin
  delete from public.deepseek_job where expires_at < now() - interval '1 hour';
  get diagnostics v_deleted = row_count;
  -- A worker that died mid-stream must not wedge the queue forever.
  update public.deepseek_job
     set status = 'queued', worker_id = null, claimed_at = null,
         metrics = metrics || jsonb_build_object('requeued_at', now(), 'requeue_reason', 'worker timeout')
   where status in ('claimed', 'streaming')
     and coalesce(claimed_at, created_at) < now() - interval '3 minutes';
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs — client side
-- ---------------------------------------------------------------------------

-- Queue a conversation. Validates shape, rate limits, and returns the job id.
create or replace function public.deepseek_enqueue(
  p_messages jsonb,
  p_model    text default 'deepseek-chat'
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_recent integer;
  v_pending integer;
  v_id uuid;
begin
  perform app.deepseek_purge();

  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_messages');
  end if;

  if jsonb_array_length(p_messages) = 0 or jsonb_array_length(p_messages) > 60 then
    return jsonb_build_object('ok', false, 'error', 'bad_message_count', 'max', 60);
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_messages) as m
     where coalesce(m ->> 'role', '') not in ('system', 'user', 'assistant')
        or jsonb_typeof(m -> 'content') <> 'string'
        or octet_length(m ->> 'content') > 32768
  ) then
    return jsonb_build_object('ok', false, 'error', 'bad_message_shape');
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

  insert into public.deepseek_job (model, messages)
    values (left(coalesce(nullif(btrim(p_model), ''), 'deepseek-chat'), 64), p_messages)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_id,
    'status', 'queued',
    'expires_at', (now() + interval '1 hour')
  );
end;
$$;

-- Poll for progress. Returns every chunk with seq > p_since_seq.
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
    'finished', v_job.status in ('done', 'error', 'cancelled')
  );
end;
$$;

-- Cancel a job the caller is waiting on (a worker sees 'cancelled' and aborts).
create or replace function public.deepseek_cancel(p_job_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_status text;
begin
  select status into v_status from public.deepseek_job where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_status in ('done', 'cancelled') then
    return jsonb_build_object('ok', true, 'status', v_status);
  end if;

  update public.deepseek_job
     set status = 'cancelled', finished_at = now(), error = coalesce(error, 'cancelled by user')
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$$;

-- Snapshot for the UI status strip: is an edge relay configured / are browser workers
-- alive? (Alive = any worker claimed something in the last 30 seconds.)
create or replace function public.deepseek_health()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_out jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'pending', count(*) filter (where status in ('queued', 'claimed', 'streaming')),
    'queued', count(*) filter (where status = 'queued'),
    'workers_alive', count(distinct worker_id) filter (
      where worker_id is not null and coalesce(claimed_at, created_at) > now() - interval '30 seconds'
    ),
    'done_last_hour', count(*) filter (where status = 'done' and created_at > now() - interval '1 hour'),
    'error_last_hour', count(*) filter (where status = 'error' and created_at > now() - interval '1 hour')
  ) into v_out from public.deepseek_job
   where created_at > now() - interval '1 hour';

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs — transport side (edge function or browser worker)
-- ---------------------------------------------------------------------------

-- Claim a queued job. With p_job_id the caller targets the job it just enqueued; without
-- it, the oldest queued job wins (browser workers compete fairly). p_worker_id doubles as
-- a heartbeat so deepseek_health() can report live workers.
drop function if exists public.deepseek_claim(text);
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

  -- Heartbeat: a worker that claims nothing still proves it is alive.
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
    'messages', v_job.messages
  );
end;
$$;

-- Append one streamed chunk. First chunk flips the job to 'streaming' and records TTFT.
create or replace function public.deepseek_append(
  p_job_id  uuid,
  p_seq     integer,
  p_payload jsonb
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
  if v_job.status in ('cancelled', 'done', 'error') then
    return jsonb_build_object('ok', false, 'error', 'job_' || v_job.status);
  end if;
  if jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_payload');
  end if;

  insert into public.deepseek_chunk (job_id, seq, payload)
    values (p_job_id, p_seq, p_payload)
  on conflict (job_id, seq) do nothing;

  update public.deepseek_job
     set status = 'streaming',
         claimed_at = now(),
         transport = coalesce(transport, p_payload ->> '_transport'),
         metrics = case
           when v_job.status = 'claimed' then metrics || jsonb_build_object('first_chunk_at', now())
           else metrics
         end
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'seq', p_seq);
end;
$$;

-- Finish a job. p_metrics may carry upstream timings for latency accounting.
create or replace function public.deepseek_complete(
  p_job_id  uuid,
  p_ok      boolean default true,
  p_error   text default null,
  p_metrics jsonb default '{}'::jsonb
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
         metrics = metrics || coalesce(p_metrics, '{}'::jsonb) || jsonb_build_object('finished_at', now())
   where id = p_job_id
   returning * into v_job;

  return jsonb_build_object('ok', true, 'status', v_job.status, 'metrics', v_job.metrics);
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: broadcast chunks and job state to the waiting UI.
-- ---------------------------------------------------------------------------

alter table public.deepseek_job   replica identity full;
alter table public.deepseek_chunk replica identity full;

alter table public.deepseek_job   enable row level security;
alter table public.deepseek_chunk enable row level security;

-- Realtime authorises with RLS, so anon needs SELECT (read-only) on both tables.
-- Conversation text is therefore readable by any anon key holder — acceptable for a
-- personal toolbox, and writes are still RPC-only.
drop policy if exists deepseek_job_read on public.deepseek_job;
create policy deepseek_job_read on public.deepseek_job
  for select to anon, authenticated using (true);
drop policy if exists deepseek_chunk_read on public.deepseek_chunk;
create policy deepseek_chunk_read on public.deepseek_chunk
  for select to anon, authenticated using (true);

-- Adding to the Realtime publication needs ownership of the publication, which the
-- postgres role does not always have. Degrade to polling instead of failing the
-- migration when that happens (the UI falls back automatically).
do $$
declare
t text;
begin
  foreach t in array array['deepseek_job', 'deepseek_chunk'] loop
    begin
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    exception when insufficient_privilege then
      raise notice 'not subscribed to supabase_realtime: public.% (add it in the dashboard)', t;
    end;
  end loop;
end $$;

revoke all on public.deepseek_job   from anon, authenticated;
revoke all on public.deepseek_chunk from anon, authenticated;
grant select on public.deepseek_job   to anon, authenticated;
grant select on public.deepseek_chunk to anon, authenticated;

alter function public.deepseek_enqueue(jsonb, text)   owner to postgres;
alter function public.deepseek_status(uuid, integer)  owner to postgres;
alter function public.deepseek_cancel(uuid)           owner to postgres;
alter function public.deepseek_health()               owner to postgres;
alter function public.deepseek_claim(text, uuid)      owner to postgres;
alter function public.deepseek_append(uuid, integer, jsonb) owner to postgres;
alter function public.deepseek_complete(uuid, boolean, text, jsonb) owner to postgres;
alter function app.deepseek_purge()                   owner to postgres;

revoke all on function public.deepseek_enqueue(jsonb, text)          from public;
revoke all on function public.deepseek_status(uuid, integer)         from public;
revoke all on function public.deepseek_cancel(uuid)                  from public;
revoke all on function public.deepseek_health()                      from public;
revoke all on function public.deepseek_claim(text, uuid)              from public;
revoke all on function public.deepseek_append(uuid, integer, jsonb)  from public;
revoke all on function public.deepseek_complete(uuid, boolean, text, jsonb) from public;

grant execute on function public.deepseek_enqueue(jsonb, text)          to anon, authenticated, service_role;
grant execute on function public.deepseek_status(uuid, integer)         to anon, authenticated, service_role;
grant execute on function public.deepseek_cancel(uuid)                  to anon, authenticated, service_role;
grant execute on function public.deepseek_health()                      to anon, authenticated, service_role;
grant execute on function public.deepseek_claim(text, uuid)           to anon, authenticated, service_role;
grant execute on function public.deepseek_append(uuid, integer, jsonb)  to anon, authenticated, service_role;
grant execute on function public.deepseek_complete(uuid, boolean, text, jsonb) to anon, authenticated, service_role;
