// Run with PGLITE_MODULE pointing to @electric-sql/pglite's dist/index.js.
// This is a real PostgreSQL-engine test, with only Supabase Auth's identity
// context mocked. PGlite is a test tool, not a browser/runtime dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const moduleName = process.env.PGLITE_MODULE
  ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const db = await PGlite.create();
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const same = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const rows = async (sql, params=[]) => (await db.query(sql,params)).rows;
const scalar = async (sql,params=[]) => Object.values((await rows(sql,params))[0])[0];
async function asUser(uid, sql, params=[]) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[uid??'']);
  await db.exec('set role authenticated');
  try { return await scalar(sql, params); }
  finally { await db.exec('reset role'); }
}
const login = (uid,first,last,code,group='SE-2421') => asUser(uid,
  `select public.sign_in_student($1,$2,$3,$4)`,[first,last,group,code]);
async function api(uid,action,payload={},reset=true) {
  if(reset) await db.exec(`update private.students set last_action_at=null`);
  return asUser(uid,`select public.queue_api($1,$2::jsonb)`,[action,JSON.stringify(payload)]);
}

try {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
  `);
  await db.exec(await fs.readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  // Applying the schema a second time must not destroy existing data/configuration.
  await db.exec(await fs.readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  check(true,'schema compiles and can be reapplied');
  const admin=randomUUID(), alice=randomUUID(), bob=randomUUID(), outsider=randomUUID(), unknown=randomUUID();
  for(const id of [admin,alice,bob,outsider,unknown]) await db.query('insert into auth.users(id) values($1)',[id]);
  await db.exec(`
    select private.upsert_student('SE-2421','900001','Admin','Example','admin');
    select private.upsert_student('SE-2421','900002','Alice','Example');
    select private.upsert_student('SE-2421','900003','Bob','Example');
    insert into private.groups(code,timezone) values('OTHER-GROUP','UTC');
    select private.upsert_student('OTHER-GROUP','900004','Other','Example','admin');
  `);
  same((await api(unknown,'state')).error.code,'NOT_REGISTERED','unmapped session has no data');
  same((await login(alice,'Wrong','Example','900002')).error.code,'INVALID_STUDENT','name must match private roster');
  for(let i=0;i<9;i++) await login(unknown,'Wrong','Example','bad');
  same((await login(unknown,'Wrong','Example','bad')).error.code,'INVALID_STUDENT','tenth bad attempt is counted');
  same((await login(unknown,'Wrong','Example','bad')).error.code,'RATE_LIMITED','bad attempts persist despite returned errors');
  let state=await login(admin,'Admin','Example','900001');
  same(state.user.role,'admin','admin role comes from roster');
  same(state.group.member_count,3,'only active group members counted');
  check(!JSON.stringify(state).includes('900001'),'student code not exposed in state');
  check(!JSON.stringify(state).includes('code_hash'),'code hash not exposed');
  const aliceState=await login(alice,' alice ',' example ','900002','se-2421');
  same(aliceState.user.role,'student','student cannot choose role');
  await login(bob,'Bob','Example','900003');
  await login(outsider,'Other','Example','900004','OTHER-GROUP');
  const secondDevice=randomUUID(); await db.query('insert into auth.users(id) values($1)',[secondDevice]);
  same((await login(secondDevice,'Alice','Example','900002')).user.id,aliceState.user.id,
    'new device maps to same student rather than a duplicate profile');

  await db.exec('begin');
  try {
    await api(admin,'state',{},false);
    same(await scalar(`select count(*)::integer from pg_locks where pid=pg_backend_pid() and locktype='advisory'`),
      0,'state reads do not acquire mutation advisory locks');
    same(await scalar(`select count(*)::integer from pg_locks where pid=pg_backend_pid()
      and relation='private.students'::regclass and mode='RowShareLock'`),
      0,'state reads do not acquire FOR UPDATE row-lock relation modes');
  } finally { await db.exec('rollback'); }
  await db.exec('begin');
  try {
    await api(admin,'create_subject',{name:'Temporary locking assertion'});
    same(await scalar(`select count(*)::integer from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted`),
      1,'a group mutation holds its advisory transaction lock');
  } finally { await db.exec('rollback'); }

  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[alice]);
  await db.exec('set role authenticated');
  try {
    let blocked=false;
    try { await db.query('select * from private.students'); } catch(error) { blocked=error.code==='42501'; }
    check(blocked,'browser cannot select private roster');
    const safe=(await db.query('select * from public.group_revisions')).rows;
    same(safe.length,1,'RLS returns only own revision row');
    check(!('student_code' in safe[0]),'realtime projection contains no student codes');
    let helperBlocked=false;
    try { await db.query(`select private.upsert_student('SE-2421','900005','Hacker','Example','admin')`); }
    catch(error) { helperBlocked=error.code==='42501'; }
    check(helperBlocked,'browser cannot execute owner roster helper');
  } finally { await db.exec('reset role'); }

  same((await api(alice,'create_subject',{name:'Forbidden'})).error.code,'FORBIDDEN','student cannot create subjects');
  same((await api(alice,'state',{},false)).user.role,'student','state remains available during cooldown');
  same((await api(alice,'join',{queue_id:randomUUID()},false)).error.code,'COOLDOWN','mutation cooldown is enforced on server');
  state=await api(admin,'create_subject',{name:'Cloud Computing'});
  const cloud=state.subjects.find(s=>s.name==='Cloud Computing').id;
  same((await api(admin,'create_subject',{name:'  CLOUD   computing  '})).error.code,'DUPLICATE_SUBJECT','normalized names prevent duplicate subjects');
  state=await api(admin,'create_subject',{name:'Computer Networks'});
  const networks=state.subjects.find(s=>s.name==='Computer Networks').id;
  const now=Date.now();
  state=await api(admin,'create_queue',{subject_id:cloud,starts_at:new Date(now-60_000).toISOString(),
    opens_at:new Date(now-120_000).toISOString(),closes_at:new Date(now+7_200_000).toISOString()});
  const queueId=state.queues.find(q=>q.subject_id===cloud).id;
  state=await api(alice,'join',{queue_id:queueId});
  same(state.queues.find(q=>q.id===queueId).my_position,1,'first waiting position is one');
  const aliceEntry=state.queues.find(q=>q.id===queueId).my_entry_id;
  state=await api(secondDevice,'join',{queue_id:queueId});
  same(state.queues.find(q=>q.id===queueId).entries.length,1,'second device cannot create duplicate enrollment');
  same(state.queues.find(q=>q.id===queueId).my_entry_id,aliceEntry,'join is idempotent');
  state=await api(bob,'join',{queue_id:queueId});
  same(state.queues.find(q=>q.id===queueId).my_position,2,'second student waits second');
  let queue=state.queues.find(q=>q.id===queueId);
  const beforeNext=queue.revision;
  same((await api(alice,'next',{queue_id:queueId,expected_revision:beforeNext})).error.code,'FORBIDDEN','only admins advance');
  state=await api(admin,'next',{queue_id:queueId,expected_revision:beforeNext});
  queue=state.queues.find(q=>q.id===queueId);
  same(queue.current_entry_id,aliceEntry,'first call starts first defense');
  same(queue.waiting_count,1,'current person excluded from waiting count');
  const activeState=await api(alice,'state');
  same(activeState.queues.find(q=>q.id===queueId).my_position,0,'active participant position is zero');
  same((await api(alice,'leave',{queue_id:queueId})).error.code,'CURRENT_STUDENT_CANNOT_LEAVE','active person cannot self-advance');
  same((await api(admin,'next',{queue_id:queueId,expected_revision:beforeNext})).error.code,'QUEUE_CHANGED','repeated stale next cannot skip a person');
  same((await api(outsider,'join',{queue_id:queueId})).error.code,'QUEUE_NOT_FOUND','other group cannot enroll');
  same((await api(admin,'remove_entry',{queue_id:queueId,entry_id:randomUUID()})).error.code,'ENTRY_NOT_FOUND','entry must belong to queue');
  state=await api(admin,'remove_entry',{queue_id:queueId,entry_id:aliceEntry});
  queue=state.queues.find(q=>q.id===queueId);
  same(queue.current_entry_id,null,'removing active participant clears active slot');
  same(queue.entries[0].position,1,'remaining person waits first, not automatically called');
  state=await api(admin,'next',{queue_id:queueId,expected_revision:queue.revision});
  queue=state.queues.find(q=>q.id===queueId);
  check(queue.current_entry_id!==null,'admin can explicitly call remaining person');
  state=await api(admin,'close_queue',{queue_id:queueId});
  same(state.queues.find(q=>q.id===queueId).status,'closed','close applies immediately');
  same((await api(alice,'join',{queue_id:queueId})).error.code,'QUEUE_CLOSED','closed queue rejects enrollment');
  state=await api(admin,'archive_queue',{queue_id:queueId});
  check(!state.queues.some(q=>q.id===queueId),'archived queue omitted from active state');

  const otherState=await api(outsider,'create_subject',{name:'Other group schedule'});
  const otherSubject=otherState.subjects[0].id;
  await db.query(`insert into private.schedules(subject_id,weekday,local_time) values($1,4,'14:00')`,[otherSubject]);
  state=await api(admin,'save_schedule',{subject_id:networks,weekday:4,local_time:'14:00',opens_minutes_before:120,duration_minutes:120,enabled:true});
  same(await scalar(`select count(*)::integer from private.queues where subject_id=$1`,[otherSubject]),
    0,'saving a group schedule never acquires or mutates another group schedule');
  same(state.schedules.length,1,'weekly schedule saved');
  same(state.schedules[0].local_time,'14:00','time serialized HH:MM');
  const scheduleId=state.schedules[0].id;
  const scheduled=state.queues.filter(q=>q.subject_id===networks);
  check(scheduled.length>=1,'schedule materializes upcoming dated queue');
  for(const q of scheduled) {
    same(await scalar(`select to_char($1::timestamptz at time zone 'Asia/Qyzylorda','HH24:MI')`,[q.starts_at]),'14:00','timezone conversion correct');
    same(await scalar(`select extract(isodow from $1::timestamptz at time zone 'Asia/Qyzylorda')::integer`,[q.starts_at]),4,'ISO Thursday is correct');
  }
  await db.query('select private.generate_sessions()');
  check((await scalar(`select count(*)::integer from private.queues where subject_id=$1`,[otherSubject]))>0,
    'Cron all-groups wrapper still generates other group lessons');
  const countBefore=await scalar('select count(*)::integer from private.queues');
  await db.query('select private.generate_sessions()');
  await db.query('select private.generate_sessions()');
  same(await scalar('select count(*)::integer from private.queues'),countBefore,'cron is idempotent');
  same((await api(alice,'delete_subject',{subject_id:networks})).error.code,'FORBIDDEN','students cannot delete subjects');
  same((await api(alice,'save_schedule',{subject_id:networks,weekday:2,local_time:'10:00'})).error.code,'FORBIDDEN','students cannot edit schedules');
  state=await api(admin,'delete_schedule',{schedule_id:scheduleId});
  same(state.schedules.length,0,'schedule deletion works');
  state=await api(admin,'delete_subject',{subject_id:networks});
  check(!state.subjects.some(s=>s.id===networks),'subject removed from current state');
  check(!state.queues.some(q=>q.subject_id===networks),'related queues removed');
  same(state.group.member_count,3,'subject deletion does not delete students');
  same((await api(admin,'create_queue',{subject_id:cloud,starts_at:'not-a-date'})).error.code,'INVALID_INPUT','malformed timestamps return safe error envelope');
  same((await api(admin,'join',{queue_id:'not-a-uuid'})).error.code,'INVALID_INPUT','malformed UUID returns safe error');
  check(!JSON.stringify(await api(alice,'state')).includes('900002'),'all state responses keep codes private');

  await db.exec('set role anon');
  try {
    let denied=false;
    try { await db.query(`select public.queue_api('state')`); } catch(error) { denied=error.code==='42501'; }
    check(denied,'public anon API key alone cannot call app RPC');
  } finally { await db.exec('reset role'); }
  console.log(`PASS: ${checks} PostgreSQL backend assertions`);
} finally { await db.close(); }
