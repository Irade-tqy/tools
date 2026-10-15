-- 0008 — a turn that never answered has no time-to-first-token.
--
-- Why: the relay wrote upstream_ttft_ms = 0 for every turn that produced no answer, which is
-- exactly what DeepSeek's own outage produced for an hour (event: hint / "服务器暂时不可用" /
-- backend_err). health's median_ttft_ms aggregates over whatever carries the key, so the public
-- status strip reported 「中位首字 0ms」 while the service was failing, and db-test's median
-- assertion failed in CI because the seeded sample was outvoted by zeros.
--
-- Strips the key from rows that recorded 0, and makes the median count only positive measured
-- values, so the strip reflects turns that actually answered.

update public.deepseek_job
   set metrics = metrics - 'upstream_ttft_ms'
 where jsonb_typeof(metrics -> 'upstream_ttft_ms') = 'number'
   and (metrics ->> 'upstream_ttft_ms')::numeric <= 0;

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
             and case
                   when jsonb_typeof(metrics -> 'upstream_ttft_ms') = 'number'
                   then (metrics ->> 'upstream_ttft_ms')::numeric > 0
                   else false
                 end
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

-- Fail loudly if the median filter lost its positivity guard, so the 0ms strip cannot return.
do $$
declare
  v_body text;
begin
  select pg_get_functiondef('public.deepseek_health()'::regprocedure) into v_body;
  if v_body not like '%> 0%' then
    raise exception 'deepseek_health median no longer ignores non-positive samples';
  end if;
end;
$$;
