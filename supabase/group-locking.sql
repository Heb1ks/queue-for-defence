-- Uniform per-group transaction locking. Apply after the initial schema.
begin;

create or replace function private.generate_group_sessions(p_group_id uuid,p_now timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_schedule record; v_day date; v_today date; v_starts timestamptz; v_inserted uuid; v_count integer:=0;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('queue-for-defence:'||p_group_id::text,0));
  for v_schedule in select sc.*,sub.group_id,sub.name,g.timezone from private.schedules sc
    join private.subjects sub on sub.id=sc.subject_id join private.groups g on g.id=sub.group_id
    where sc.enabled and sub.group_id=p_group_id order by sc.id
  loop
    v_today:=(p_now at time zone v_schedule.timezone)::date;
    for v_day in select generate_series(v_today-1,v_today+7,interval '1 day')::date loop
      if extract(isodow from v_day)::integer<>v_schedule.weekday then continue; end if;
      v_starts:=(v_day+v_schedule.local_time) at time zone v_schedule.timezone;
      if v_starts+make_interval(mins=>v_schedule.duration_minutes)<=p_now then continue; end if;
      v_inserted:=null;
      insert into private.queues(subject_id,schedule_id,occurs_on,title,starts_at,opens_at,closes_at)
        values(v_schedule.subject_id,v_schedule.id,v_day,v_schedule.name,v_starts,
          v_starts-make_interval(mins=>v_schedule.opens_minutes_before),
          v_starts+make_interval(mins=>v_schedule.duration_minutes))
        on conflict do nothing returning id into v_inserted;
      if v_inserted is not null then
        v_count:=v_count+1;
        perform private.touch_group(v_schedule.group_id);
      end if;
    end loop;
  end loop;
  -- Join/next additionally check closes_at, so late cron execution never leaves enrollment open.
  for v_schedule in
    update private.queues q set status='closed',revision=revision+1
      from private.subjects sub where sub.id=q.subject_id and sub.group_id=p_group_id
        and q.status='open' and q.closes_at<=p_now
      returning sub.group_id
  loop
    perform private.touch_group(v_schedule.group_id);
  end loop;
  return v_count;
end;
$$;

create or replace function private.generate_sessions(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare v_group record; v_count integer:=0;
begin
  for v_group in select id from private.groups order by id loop
    v_count:=v_count+private.generate_group_sessions(v_group.id,p_now);
  end loop;
  return v_count;
end;
$$;

create or replace function public.queue_api(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me private.students; v_group private.groups; v_queue private.queues; v_subject private.subjects;
  v_schedule private.schedules; v_now timestamptz:=clock_timestamp(); v_queue_id uuid; v_subject_id uuid;
  v_entry_id uuid; v_schedule_id uuid; v_first uuid; v_name text; v_starts timestamptz;
  v_opens timestamptz; v_closes timestamptz; v_retry integer; v_expected bigint; v_weekday integer;
  v_local_time time; v_before integer; v_duration integer; v_enabled boolean;
begin
  if auth.uid() is null then return private.api_error('UNAUTHENTICATED'); end if;
  select s.* into v_me from private.students s join private.student_sessions x on x.student_id=s.id
    where x.auth_user_id=auth.uid() and s.active;
  if v_me.id is null then return private.api_error('NOT_REGISTERED'); end if;
  select * into v_group from private.groups where id=v_me.group_id;
  if p_action='state' then return private.build_state(v_me.id); end if;
  if p_action not in ('join','leave','next','remove_entry','close_queue','archive_queue',
    'create_subject','delete_subject','create_queue','save_schedule','delete_schedule') then
    return private.api_error('INVALID_ACTION');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('queue-for-defence:'||v_group.id::text,0));
  -- Recheck the active roster mapping after waiting for the group lock. State
  -- reads above never lock rows and are unaffected by the mutation cooldown.
  select s.* into v_me from private.students s join private.student_sessions x on x.student_id=s.id
    where x.auth_user_id=auth.uid() and s.active for update of s;
  if v_me.id is null then return private.api_error('NOT_REGISTERED'); end if;
  if v_me.group_id<>v_group.id then return private.api_error('SESSION_EXPIRED'); end if;
  if v_me.last_action_at is not null and v_me.last_action_at>v_now-interval '5 seconds' then
    v_retry:=greatest(1,ceil(extract(epoch from v_me.last_action_at+interval '5 seconds'-v_now))::integer);
    return private.api_error('COOLDOWN',v_retry);
  end if;
  update private.students set last_action_at=v_now where id=v_me.id;
  if p_action not in ('join','leave') and v_me.role<>'admin' then
    return private.api_error('FORBIDDEN');
  end if;

  if p_action='create_subject' then
    v_name:=regexp_replace(btrim(coalesce(p_payload->>'name','')),'\s+',' ','g');
    if length(v_name) not between 1 and 80 then return private.api_error('INVALID_INPUT'); end if;
    if exists(select 1 from private.subjects where group_id=v_me.group_id and name_key=private.normalized(v_name)) then
      return private.api_error('DUPLICATE_SUBJECT');
    end if;
    if (select count(*) from private.subjects where group_id=v_me.group_id)>=30 then
      return private.api_error('LIMIT_REACHED');
    end if;
    insert into private.subjects(group_id,name,name_key) values(v_me.group_id,v_name,private.normalized(v_name));
    perform private.touch_group(v_me.group_id);

  elsif p_action in ('delete_subject','create_queue','save_schedule') then
    v_subject_id:=(p_payload->>'subject_id')::uuid;
    select * into v_subject from private.subjects where id=v_subject_id and group_id=v_me.group_id for update;
    if v_subject.id is null then return private.api_error('SUBJECT_NOT_FOUND'); end if;
    if p_action='delete_subject' then
      delete from private.subjects where id=v_subject.id;
      perform private.touch_group(v_me.group_id);
    elsif p_action='create_queue' then
      v_starts:=(p_payload->>'starts_at')::timestamptz;
      v_opens:=coalesce((p_payload->>'opens_at')::timestamptz,least(v_now,v_starts));
      v_closes:=coalesce((p_payload->>'closes_at')::timestamptz,v_starts+interval '2 hours');
      v_name:=btrim(coalesce(nullif(p_payload->>'title',''),v_subject.name));
      if v_starts is null or v_opens>v_starts or v_closes<=v_starts or length(v_name) not between 1 and 120 then
        return private.api_error('INVALID_INPUT');
      end if;
      if exists(select 1 from private.queues where subject_id=v_subject.id and starts_at=v_starts) then
        return private.api_error('DUPLICATE_QUEUE');
      end if;
      insert into private.queues(subject_id,title,starts_at,opens_at,closes_at)
        values(v_subject.id,v_name,v_starts,v_opens,v_closes);
      perform private.touch_group(v_me.group_id);
    else
      v_schedule_id:=nullif(p_payload->>'id','')::uuid;
      v_weekday:=(p_payload->>'weekday')::integer;
      v_local_time:=(p_payload->>'local_time')::time;
      v_before:=coalesce((p_payload->>'opens_minutes_before')::integer,120);
      v_duration:=coalesce((p_payload->>'duration_minutes')::integer,120);
      v_enabled:=coalesce((p_payload->>'enabled')::boolean,true);
      if v_weekday is null or v_weekday not between 1 and 7 or v_local_time is null or
        v_before not between 0 and 10080 or v_duration not between 15 and 1440 then
        return private.api_error('INVALID_INPUT');
      end if;
      if v_schedule_id is not null then
        select sc.* into v_schedule from private.schedules sc join private.subjects sub on sub.id=sc.subject_id
          where sc.id=v_schedule_id and sub.group_id=v_me.group_id for update of sc;
        if v_schedule.id is null then return private.api_error('SCHEDULE_NOT_FOUND'); end if;
        -- Only future, not-yet-open and empty sessions can be replaced automatically.
        delete from private.queues q where q.schedule_id=v_schedule.id and q.opens_at>v_now
          and not exists(select 1 from private.queue_entries e where e.queue_id=q.id);
        update private.schedules set subject_id=v_subject.id,weekday=v_weekday,local_time=v_local_time,
          opens_minutes_before=v_before,duration_minutes=v_duration,enabled=v_enabled where id=v_schedule.id;
      else
        insert into private.schedules(subject_id,weekday,local_time,opens_minutes_before,duration_minutes,enabled)
          values(v_subject.id,v_weekday,v_local_time,v_before,v_duration,v_enabled);
      end if;
      perform private.generate_group_sessions(v_me.group_id,v_now);
      perform private.touch_group(v_me.group_id);
    end if;

  elsif p_action='delete_schedule' then
    v_schedule_id:=(p_payload->>'schedule_id')::uuid;
    select sc.* into v_schedule from private.schedules sc join private.subjects sub on sub.id=sc.subject_id
      where sc.id=v_schedule_id and sub.group_id=v_me.group_id for update of sc;
    if v_schedule.id is null then return private.api_error('SCHEDULE_NOT_FOUND'); end if;
    delete from private.queues q where q.schedule_id=v_schedule.id and q.opens_at>v_now
      and not exists(select 1 from private.queue_entries e where e.queue_id=q.id);
    delete from private.schedules where id=v_schedule.id;
    perform private.touch_group(v_me.group_id);

  else
    v_queue_id:=(p_payload->>'queue_id')::uuid;
    select q.* into v_queue from private.queues q join private.subjects sub on sub.id=q.subject_id
      where q.id=v_queue_id and sub.group_id=v_me.group_id for update of q;
    if v_queue.id is null then return private.api_error('QUEUE_NOT_FOUND'); end if;
    if p_action in ('join','next') then
      if v_queue.status<>'open' or v_queue.closes_at<=v_now then return private.api_error('QUEUE_CLOSED'); end if;
      if v_queue.opens_at>v_now then return private.api_error('QUEUE_NOT_OPEN'); end if;
    end if;
    if p_action='join' then
      -- Repeated enrollment is idempotent; a database unique constraint is the final guard.
      insert into private.queue_entries(queue_id,student_id) values(v_queue.id,v_me.id)
        on conflict(queue_id,student_id) do nothing;
      if found then perform private.bump_queue(v_queue.id,v_me.group_id); end if;
    elsif p_action='leave' then
      select id into v_entry_id from private.queue_entries where queue_id=v_queue.id and student_id=v_me.id;
      if v_entry_id is null then return private.api_error('NOT_JOINED'); end if;
      if v_entry_id=v_queue.current_entry_id then return private.api_error('CURRENT_STUDENT_CANNOT_LEAVE'); end if;
      delete from private.queue_entries where id=v_entry_id;
      perform private.bump_queue(v_queue.id,v_me.group_id);
    elsif p_action='next' then
      v_expected:=(p_payload->>'expected_revision')::bigint;
      if v_expected is null then return private.api_error('INVALID_INPUT'); end if;
      if v_expected<>v_queue.revision then return private.api_error('QUEUE_CHANGED'); end if;
      if v_queue.current_entry_id is not null then delete from private.queue_entries where id=v_queue.current_entry_id; end if;
      select id into v_first from private.queue_entries where queue_id=v_queue.id order by sequence limit 1;
      update private.queues set current_entry_id=v_first where id=v_queue.id;
      perform private.bump_queue(v_queue.id,v_me.group_id);
    elsif p_action='remove_entry' then
      v_entry_id:=(p_payload->>'entry_id')::uuid;
      if not exists(select 1 from private.queue_entries where id=v_entry_id and queue_id=v_queue.id) then
        return private.api_error('ENTRY_NOT_FOUND');
      end if;
      if v_entry_id=v_queue.current_entry_id then update private.queues set current_entry_id=null where id=v_queue.id; end if;
      delete from private.queue_entries where id=v_entry_id and queue_id=v_queue.id;
      perform private.bump_queue(v_queue.id,v_me.group_id);
    elsif p_action='close_queue' then
      update private.queues set status='closed' where id=v_queue.id;
      perform private.bump_queue(v_queue.id,v_me.group_id);
    elsif p_action='archive_queue' then
      update private.queues set status='archived' where id=v_queue.id;
      perform private.bump_queue(v_queue.id,v_me.group_id);
    end if;
  end if;
  return private.build_state(v_me.id);
exception
  when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or
    numeric_value_out_of_range or check_violation or not_null_violation then
    return private.api_error('INVALID_INPUT');
  when unique_violation then return private.api_error('DUPLICATE');
end;
$$;

revoke execute on function private.generate_group_sessions(uuid,timestamptz) from public,anon,authenticated;
commit;
