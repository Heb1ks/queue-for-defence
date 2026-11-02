-- Queue for Defence: apply once in the Supabase SQL Editor as project owner.
-- The public browser API consists only of two RPC functions and group_revisions.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (length(code) between 1 and 40),
  timezone text not null default 'Asia/Qyzylorda'
);
create table if not exists private.students (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references private.groups(id) on delete cascade,
  code_hash text not null unique,
  first_name text not null check (length(first_name) between 1 and 80),
  last_name text not null check (length(last_name) between 1 and 80),
  role text not null default 'student' check (role in ('student','admin')),
  active boolean not null default true,
  last_action_at timestamptz
);
create index if not exists students_group_idx on private.students(group_id);
create table if not exists private.student_sessions (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  student_id uuid not null references private.students(id) on delete cascade,
  linked_at timestamptz not null default now()
);
create index if not exists student_sessions_student_idx on private.student_sessions(student_id);
create table if not exists private.login_attempts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempts integer not null default 0
);
create table if not exists private.subjects (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references private.groups(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  name_key text not null,
  unique(group_id,name_key)
);
create table if not exists private.schedules (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references private.subjects(id) on delete cascade,
  weekday integer not null check (weekday between 1 and 7),
  local_time time not null,
  opens_minutes_before integer not null default 120 check (opens_minutes_before between 0 and 10080),
  duration_minutes integer not null default 120 check (duration_minutes between 15 and 1440),
  enabled boolean not null default true
);
create index if not exists schedules_subject_idx on private.schedules(subject_id);
create table if not exists private.queues (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references private.subjects(id) on delete cascade,
  schedule_id uuid references private.schedules(id) on delete set null,
  occurs_on date,
  title text not null check (length(title) between 1 and 120),
  starts_at timestamptz not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open','closed','archived')),
  current_entry_id uuid,
  revision bigint not null default 0,
  check (opens_at <= starts_at and starts_at < closes_at),
  unique(subject_id,starts_at),
  unique(schedule_id,occurs_on)
);
create index if not exists queues_subject_idx on private.queues(subject_id,starts_at);
create table if not exists private.queue_entries (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references private.queues(id) on delete cascade,
  student_id uuid not null references private.students(id) on delete cascade,
  sequence bigint generated always as identity,
  joined_at timestamptz not null default now(),
  unique(queue_id,student_id)
);
create index if not exists entries_queue_order_idx on private.queue_entries(queue_id,sequence);
create index if not exists queue_entries_student_idx on private.queue_entries(student_id);

create table if not exists public.group_revisions (
  group_id uuid primary key references private.groups(id) on delete cascade,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.group_revisions enable row level security;
revoke all on public.group_revisions from public, anon, authenticated;
grant select on public.group_revisions to authenticated;

create or replace function private.normalized(p_value text)
returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p_value,'')), '\s+', ' ', 'g'));
$$;

create or replace function private.code_hash(p_code text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(btrim(coalesce(p_code,'')), 'UTF8')), 'hex');
$$;

create or replace function private.api_error(p_code text,p_retry_after integer default null)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('error', jsonb_strip_nulls(jsonb_build_object(
    'code',p_code,'retry_after',p_retry_after)));
$$;

create or replace function private.can_read_group(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.student_sessions x
    join private.students s on s.id=x.student_id
    where x.auth_user_id=auth.uid() and s.active and s.group_id=p_group_id
  );
$$;
-- USAGE permits calling the narrow RLS predicate, not reading private tables.
grant usage on schema private to authenticated;
grant execute on function private.can_read_group(uuid) to authenticated;
drop policy if exists group_revisions_members on public.group_revisions;
create policy group_revisions_members on public.group_revisions
  for select to authenticated using (private.can_read_group(group_id));

create or replace function private.touch_group(p_group_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.group_revisions(group_id,revision,updated_at)
  values(p_group_id,1,clock_timestamp())
  on conflict(group_id) do update set revision=public.group_revisions.revision+1,
    updated_at=excluded.updated_at;
$$;

create or replace function private.bump_queue(p_queue_id uuid,p_group_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.queues set revision=revision+1 where id=p_queue_id;
  perform private.touch_group(p_group_id);
end;
$$;

create or replace function private.build_state(p_student_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (
    select s.*,g.code as group_code,g.timezone from private.students s
    join private.groups g on g.id=s.group_id where s.id=p_student_id and s.active
  ), visible_queues as (
    select q.*,sub.name as subject_name from private.queues q
    join private.subjects sub on sub.id=q.subject_id
    join me on me.group_id=sub.group_id
    where q.status<>'archived' and q.closes_at>now()-interval '7 days'
    order by q.starts_at,q.id limit 100
  ), ranked as (
    select e.*,s.first_name,s.last_name,
      (e.id=q.current_entry_id) is_current,
      case when e.id=q.current_entry_id then 0 else
        row_number() over(partition by e.queue_id order by
          case when e.id=q.current_entry_id then 0 else 1 end,e.sequence)
        -case when q.current_entry_id is null then 0 else 1 end end as display_position
    from private.queue_entries e join private.students s on s.id=e.student_id
    join visible_queues q on q.id=e.queue_id
  )
  select jsonb_build_object(
    'user',jsonb_build_object('id',me.id,'first_name',me.first_name,'last_name',me.last_name,
      'group_code',me.group_code,'role',me.role),
    'group',jsonb_build_object('id',me.group_id,'code',me.group_code,'timezone',me.timezone,
      'member_count',(select count(*) from private.students s where s.group_id=me.group_id and s.active)),
    'subjects',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name)
      from private.subjects s where s.group_id=me.group_id),'[]'::jsonb),
    'queues',coalesce((select jsonb_agg(jsonb_build_object(
      'id',q.id,'subject_id',q.subject_id,'subject_name',q.subject_name,'title',q.title,
      'starts_at',q.starts_at,'opens_at',q.opens_at,'closes_at',q.closes_at,
      'status',case when q.status='closed' or q.closes_at<=now() then 'closed'
                    when q.opens_at>now() then 'upcoming' else q.status end,
      'current_entry_id',q.current_entry_id,
      'current_student_id',(select e.student_id from ranked e where e.id=q.current_entry_id),
      'revision',q.revision,
      'entries',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'student_id',e.student_id,'first_name',e.first_name,'last_name',e.last_name,
        'display_name',e.first_name||' '||e.last_name,'position',e.display_position,
        'is_current',coalesce(e.is_current,false)) order by e.display_position,e.sequence)
        from ranked e where e.queue_id=q.id),'[]'::jsonb),
      'my_entry_id',(select e.id from ranked e where e.queue_id=q.id and e.student_id=me.id),
      'my_position',(select e.display_position from ranked e where e.queue_id=q.id and e.student_id=me.id),
      'waiting_count',(select count(*) from ranked e where e.queue_id=q.id and not coalesce(e.is_current,false))
    ) order by q.starts_at,q.id) from visible_queues q),'[]'::jsonb),
    'schedules',coalesce((select jsonb_agg(jsonb_build_object(
      'id',sc.id,'subject_id',sc.subject_id,'subject_name',sub.name,'weekday',sc.weekday,
      'local_time',to_char(sc.local_time,'HH24:MI'),'opens_minutes_before',sc.opens_minutes_before,
      'duration_minutes',sc.duration_minutes,'enabled',sc.enabled) order by sc.weekday,sc.local_time)
      from private.schedules sc join private.subjects sub on sub.id=sc.subject_id
      where sub.group_id=me.group_id),'[]'::jsonb)
  ) from me;
$$;

-- Owner-only roster import. Student codes are identifiers, not strong passwords.
create or replace function private.upsert_student(
  p_group_code text,p_student_code text,p_first_name text,p_last_name text,p_role text default 'student'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_group uuid; v_id uuid;
begin
  if length(btrim(p_student_code)) not between 3 and 32 or
     length(btrim(p_first_name)) not between 1 and 80 or
     length(btrim(p_last_name)) not between 1 and 80 or p_role not in ('student','admin') then
    raise exception 'INVALID_STUDENT';
  end if;
  select id into v_group from private.groups where private.normalized(code)=private.normalized(p_group_code);
  if v_group is null then raise exception 'GROUP_NOT_FOUND'; end if;
  insert into private.students(group_id,code_hash,first_name,last_name,role)
  values(v_group,private.code_hash(p_student_code),btrim(p_first_name),btrim(p_last_name),p_role)
  on conflict(code_hash) do update set group_id=excluded.group_id,first_name=excluded.first_name,
    last_name=excluded.last_name,role=excluded.role,active=true
  returning id into v_id;
  perform private.touch_group(v_group);
  return v_id;
end;
$$;

create or replace function public.sign_in_student(
  p_first_name text,p_last_name text,p_group_code text,p_student_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid:=auth.uid(); v_now timestamptz:=clock_timestamp(); v_attempt private.login_attempts;
  v_student private.students;
begin
  if v_uid is null then return private.api_error('UNAUTHENTICATED'); end if;
  insert into private.login_attempts(auth_user_id,window_started_at,attempts)
    values(v_uid,v_now,0) on conflict(auth_user_id) do nothing;
  select * into v_attempt from private.login_attempts where auth_user_id=v_uid for update;
  if v_attempt.window_started_at<=v_now-interval '1 minute' then
    update private.login_attempts set window_started_at=v_now,attempts=0 where auth_user_id=v_uid;
    v_attempt.attempts:=0;
  end if;
  if v_attempt.attempts>=10 then
    return private.api_error('RATE_LIMITED',greatest(1,ceil(extract(epoch from
      v_attempt.window_started_at+interval '1 minute'-v_now))::integer));
  end if;
  update private.login_attempts set attempts=attempts+1 where auth_user_id=v_uid;
  if length(coalesce(p_student_code,''))>32 or length(coalesce(p_first_name,''))>80 or
     length(coalesce(p_last_name,''))>80 or length(coalesce(p_group_code,''))>40 then
    return private.api_error('INVALID_STUDENT');
  end if;
  select s.* into v_student from private.students s join private.groups g on g.id=s.group_id
    where s.active and s.code_hash=private.code_hash(p_student_code)
    and private.normalized(s.first_name)=private.normalized(p_first_name)
    and private.normalized(s.last_name)=private.normalized(p_last_name)
    and private.normalized(g.code)=private.normalized(p_group_code);
  if v_student.id is null then return private.api_error('INVALID_STUDENT'); end if;
  insert into private.student_sessions(auth_user_id,student_id) values(v_uid,v_student.id)
    on conflict(auth_user_id) do update set student_id=excluded.student_id,linked_at=v_now;
  return private.build_state(v_student.id);
end;
$$;

-- Every group mutation takes this advisory lock BEFORE student/subject/queue row
-- locks. The scheduler uses the same order, so it never holds a revision row
-- while waiting for a queue held by an API request that is waiting for revision.
-- A unique (schedule_id,occurs_on) prevents duplicate lessons.
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

-- Cron owns the all-groups wrapper. Lock groups in a stable order; requests from
-- one group use the worker directly and never acquire another group's lock.
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

-- Explicit grants: works with "Automatically expose new tables" disabled.
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.can_read_group(uuid) to authenticated;
revoke execute on function public.sign_in_student(text,text,text,text) from public,anon;
revoke execute on function public.queue_api(text,jsonb) from public,anon;
grant execute on function public.sign_in_student(text,text,text,text) to authenticated;
grant execute on function public.queue_api(text,jsonb) to authenticated;
grant usage on schema public to authenticated;

-- Supabase may install this event-trigger helper when automatic RLS is enabled.
-- Trigger execution does not require exposing the helper as a browser RPC.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  end if;
end;
$$;

insert into private.groups(code,timezone) values('SE-2421','Asia/Qyzylorda') on conflict(code) do nothing;
insert into public.group_revisions(group_id) select id from private.groups on conflict(group_id) do nothing;

commit;

-- Enable safe invalidation events if Supabase Realtime's publication exists.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='group_revisions') then
    alter publication supabase_realtime add table public.group_revisions;
  end if;
end;
$$;
