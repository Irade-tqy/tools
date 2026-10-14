-- 0007 — one signature per RPC: drop the stale overloads.
--
-- PostgREST cannot overload: when a call's parameters match more than one candidate it fails
-- with PGRST203 ("Could not choose the best candidate function"). Later migrations replaced
-- deepseek_ask / deepseek_claim / deepseek_complete with wider versions but left the earlier
-- signatures in place, so every caller that omits the trailing parameters was broken:
--
--   deepseek_ask     p_queue omitted   → ambiguous since 0006
--   deepseek_claim   p_queue omitted   → ambiguous since 0006
--   deepseek_complete p_session_id… omitted → ambiguous since 0003
--
-- The web client sends every parameter, so the site kept working while the dev scripts
-- silently lost work: drainDeepseekQueue() claims with p_worker_id only and completes with
-- three parameters, so it read PGRST203 as "nothing queued" and jobs piled up.

drop function if exists public.deepseek_ask(text, text, bigint, text, boolean, boolean, jsonb);
drop function if exists public.deepseek_claim(text, uuid);
drop function if exists public.deepseek_complete(uuid, boolean, text, jsonb);

-- Fail loudly if any overload survived, so this cannot regress unnoticed.
do $$
declare
  v_name text;
  v_count integer;
begin
  foreach v_name in array array['deepseek_ask', 'deepseek_claim', 'deepseek_complete'] loop
    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_count <> 1 then
      raise exception 'public.% has % candidates, expected exactly 1', v_name, v_count;
    end if;
  end loop;
end;
$$;

-- No function in these schemas may be overloaded, for the same reason.
do $$
declare
  v_row record;
begin
  for v_row in
    select n.nspname, p.proname, count(*) as candidates
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app')
       and (p.proname like 'deepseek%' or p.proname like 'clipboard%' or p.proname like 'tools%')
     group by n.nspname, p.proname
    having count(*) > 1
  loop
    raise exception 'overloaded RPC %.% (% candidates) — PostgREST cannot resolve it', v_row.nspname, v_row.proname, v_row.candidates;
  end loop;
end;
$$;
