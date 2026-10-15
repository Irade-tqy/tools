-- 0010 — write a batch of streamed chunks in one round-trip.
--
-- The relay used to call deepseek_append once per chunk, and each call is a full HTTPS round-trip
-- to PostgREST. DeepSeek streams the thinking text in ~1-character patches, so an 82-token answer
-- became 101 chunks; at ~310 ms per round-trip from this box the relay had read the whole answer
-- from DeepSeek in 2.0 s (upstream_total_ms) but spent 35.7 s dribbling it into the database, and
-- the browser rendered at that pace — about 2 tokens/s on screen while the upstream was done.
-- One RPC per batch turns 101 round-trips into 13.

create or replace function public.deepseek_append_many(
  p_job_id uuid,
  p_chunks jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_job    public.deepseek_job%rowtype;
  v_added  integer;
begin
  select * into v_job from public.deepseek_job where id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_job.status in ('cancelled', 'done', 'error') then
    return jsonb_build_object('ok', false, 'error', 'job_' || v_job.status);
  end if;
  if jsonb_typeof(p_chunks) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_chunks');
  end if;

  -- Every element must be {seq:int, payload:object}; anything else is a client bug and is
  -- rejected rather than half-written.
  if exists (
    select 1
      from jsonb_array_elements(p_chunks) as c
     where jsonb_typeof(c) <> 'object'
        or jsonb_typeof(c -> 'payload') <> 'object'
        or jsonb_typeof(c -> 'seq') <> 'number'
  ) then
    return jsonb_build_object('ok', false, 'error', 'bad_chunk_shape');
  end if;

  insert into public.deepseek_chunk (job_id, seq, payload)
  select p_job_id, (c ->> 'seq')::int, c -> 'payload'
    from jsonb_array_elements(p_chunks) as c
   on conflict (job_id, seq) do nothing;
  get diagnostics v_added = row_count;

  update public.deepseek_job
     set status = 'streaming',
         claimed_at = now(),
         transport = coalesce(transport, p_chunks -> 0 -> 'payload' ->> '_transport'),
         metrics = case
           when v_job.status = 'claimed' then metrics || jsonb_build_object('first_chunk_at', now())
           else metrics
         end
   where id = p_job_id;

  return jsonb_build_object(
    'ok', true,
    'written', v_added,
    'attempted', jsonb_array_length(p_chunks)
  );
end;
$$;

alter function public.deepseek_append_many(uuid, jsonb) owner to postgres;
revoke all on function public.deepseek_append_many(uuid, jsonb) from public;
grant execute on function public.deepseek_append_many(uuid, jsonb) to anon, authenticated, service_role;
