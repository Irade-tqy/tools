-- 0004 — relay liveness.
--
-- Why: deepseek_health() reported workers_alive from deepseek_job.claimed_at, which only
-- moves when a job is actually claimed. An idle relay (the normal state between turns) was
-- therefore indistinguishable from "nobody is serving the queue", and the site told users
-- their message was waiting for a relay that was sitting right there. Same reason a
-- self-hosted relay (scripts/deepseek-worker.mjs) could not prove it was up.
--
-- Adds a heartbeat table + RPC, makes deepseek_claim heartbeat on every call (even when it
-- finds nothing), and counts workers_alive from the heartbeat instead of the job rows.

create table if not exists public.deepseek_worker (
  worker_id  text primary key,
  kind       text   not null default 'relay',
  seen_at    timestamptz not null default now(),
  turns      integer     not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

comment on table public.deepseek_worker is
  'One row per relay (Edge Function instance, self-hosted worker, browser tab). Heartbeat only — no credentials.';

alter table public.deepseek_worker enable row level security;
revoke all on public.deepseek_worker from anon, authenticated;
grant select on public.deepseek_worker to service_role;

-- ---------------------------------------------------------------------------
-- heartbeat
-- ---------------------------------------------------------------------------

create or replace function public.deepseek_heartbeat(
  p_worker_id text,
  p_kind      text default 'relay',
  p_error     text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 64);
  v_row    record;
begin
  if v_worker = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_worker_id');
  end if;

  insert into public.deepseek_worker as w (worker_id, kind, seen_at)
       values (v_worker, left(coalesce(nullif(btrim(p_kind), ''), 'relay'), 32), now())
  on conflict (worker_id) do update
     set kind = excluded.kind,
         seen_at = now(),
         last_error = coalesce(p_error, w.last_error)
  returning w.* into v_row;

  return jsonb_build_object(
    'ok', true,
    'worker_id', v_row.worker_id,
    'kind', v_row.kind,
    'seen_at', v_row.seen_at,
    'turns', v_row.turns
  );
end;
$$;

-- Claim doubles as the heartbeat: a relay that finds nothing to do still has to prove it is
-- listening, otherwise an idle queue looks like a dead relay.
create or replace function public.deepseek_claim(p_worker_id text, p_job_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_job    public.deepseek_job%rowtype;
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 64);
begin
  if v_worker = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_worker_id');
  end if;

  perform app.deepseek_purge();

  -- Heartbeat first: even a claim that finds no work keeps this relay counted as alive.
  insert into public.deepseek_worker as w (worker_id, kind, seen_at)
       values (v_worker, 'relay', now())
  on conflict (worker_id) do update set seen_at = now();

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

  update public.deepseek_worker
     set turns = turns + 1, seen_at = now()
   where worker_id = v_worker;

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

-- TTL: a relay that stopped heartbeating disappears with the rest of the garbage.
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
  delete from public.deepseek_worker where seen_at < now() - interval '1 day';
  return v_deleted;
end;
$$;

-- workers_alive now answers "is a relay listening?" instead of "did a relay take a job in
-- the last 30 seconds". The job-based count stays as a fallback for relays that predate this
-- migration, and the list is what the hidden admin page shows.
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
           where created_at > now() - interval '1 hour'
             and metrics ? 'upstream_ttft_ms'
        ) s
    )
  ) into v_out from public.deepseek_job
   where created_at > now() - interval '1 hour';

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
       where worker_id is not null
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

alter function public.deepseek_heartbeat(text, text, text) owner to postgres;
alter function public.deepseek_claim(text, uuid)           owner to postgres;
alter function app.deepseek_purge()                        owner to postgres;

revoke all on function public.deepseek_heartbeat(text, text, text) from public;
grant execute on function public.deepseek_heartbeat(text, text, text) to anon, authenticated, service_role;
