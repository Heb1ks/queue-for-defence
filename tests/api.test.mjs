import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, createLiveApi, readableError } from '../src/api.js';

const config = { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test' };
const fixture = (revision = 1) => ({
  user: { id: 'student-1', first_name: 'Демо', last_name: 'Студент', group_code: 'SE-2421', role: 'student' },
  group: { id: 'group-1', code: 'SE-2421', timezone: 'Asia/Qyzylorda' },
  subjects: [{ id: 'subject-1', name: 'Cloud Computing' }],
  queues: [{ id: 'queue-1', revision, entries: [] }], schedules: [],
});
const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeClient({ session = null, rpc } = {}) {
  const calls = [], channels = [];
  let currentSession = session;
  const client = {
    calls, channels,
    auth: {
      async getSession() { calls.push(['getSession']); return { data: { session: currentSession }, error: null }; },
      async signInAnonymously() {
        calls.push(['signInAnonymously']); currentSession = { user: { id: 'auth-1' } };
        return { data: { session: currentSession }, error: null };
      },
      async signOut(options) { calls.push(['signOut', options]); currentSession = null; return { error: null }; },
    },
    async rpc(name, parameters) {
      calls.push(['rpc', name, parameters]);
      return rpc ? rpc(name, parameters) : { data: fixture(), error: null };
    },
    channel(name) {
      const channel = {
        name,
        on(event, filter, callback) { this.event = event; this.filter = filter; this.callback = callback; return this; },
        subscribe(callback) { this.status = callback; return this; },
      };
      channels.push(channel); return channel;
    },
    async removeChannel(channel) { calls.push(['removeChannel', channel.name]); },
  };
  return client;
}

function watchEnvironment() {
  let nextId = 0;
  const scheduled = new Map(), handlers = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name) { handlers.delete(name); },
  };
  return {
    document, scheduled, handlers,
    setTimeout(callback, delay) { const id = ++nextId; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    async run(delay) {
      const entry = [...scheduled].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `timer ${delay} is scheduled`);
      scheduled.delete(entry[0]); await entry[1].callback(); await settle();
    },
    async visibility(value) {
      document.visibilityState = value; handlers.get('visibilitychange')?.(); await settle();
    },
  };
}

test('missing configuration stays unconfigured and does not start auth or load SDK', async () => {
  let loads = 0;
  const api = createLiveApi({}, { loadSdk: () => { loads++; } });
  assert.equal(api.isConfigured, false);
  assert.equal(await api.restore(), null);
  await assert.rejects(api.login({}), { code: 'NOT_CONFIGURED' });
  assert.equal(loads, 0);
});

test('secret or service role keys cannot be used in the browser client', async () => {
  const jwt = `${btoa('{}')}.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`;
  for (const key of ['sb_secret_private', jwt]) {
    const api = createLiveApi({ ...config, supabasePublishableKey: key });
    assert.equal(api.isConfigured, false);
    await assert.rejects(api.login({}), { code: 'INVALID_CONFIG' });
  }
});

test('SDK is lazy and restoration without a session never creates an anonymous user', async () => {
  const sdk = fakeClient(); let loads = 0;
  const api = createLiveApi(config, { loadSdk: async () => {
    loads++; return { createClient: () => sdk };
  } });
  assert.equal(loads, 0);
  assert.equal(await api.restore(), null);
  assert.equal(loads, 1);
  assert.deepEqual(sdk.calls, [['getSession']]);
});

test('login creates a session once and passes exact trimmed roster fields without coercing student code', async () => {
  const client = fakeClient();
  const api = createLiveApi(config, { client });
  const fields = { first_name: ' Демо ', last_name: ' Студент ', group_code: ' SE-2421 ', student_code: ' 000123 ' };
  const result = await api.login(fields);
  assert.equal(result.user.id, 'student-1');
  assert.deepEqual(client.calls.find(call => call[0] === 'rpc'), ['rpc', 'sign_in_student', {
    p_first_name: 'Демо', p_last_name: 'Студент', p_group_code: 'SE-2421', p_student_code: '000123',
  }]);
  await api.login(fields);
  assert.equal(client.calls.filter(call => call[0] === 'signInAnonymously').length, 1);
});

test('backend failure envelopes are errors rather than false successful logins or mutations', async () => {
  let fail = true;
  const client = fakeClient({ rpc: async () => fail
    ? { data: { error: { code: 'COOLDOWN', retry_after: 3 } }, error: null }
    : { data: fixture(2), error: null } });
  const api = createLiveApi(config, { client });
  await assert.rejects(api.mutate('join', { queue_id: 'queue-1' }), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'COOLDOWN');
    assert.equal(error.retryAfter, 3); assert.match(error.message, /3 сек/); return true;
  });
  fail = false;
  assert.equal((await api.mutate('join', { queue_id: 'queue-1' })).queues[0].revision, 2);
  assert.match(readableError({ code: 'INVALID_STUDENT' }), /ФИО/);
});

test('restore returns null for an unmapped session but keeps network failures visible', async () => {
  const client = fakeClient({ session: { user: { id: 'auth-1' } }, rpc: async () => (
    { data: { error: { code: 'NOT_REGISTERED' } }, error: null }) });
  const api = createLiveApi(config, { client });
  assert.equal(await api.restore(), null);
  client.rpc = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.restore(), { code: 'NETWORK' });
});

test('mutations reject overlapping submissions and stale reads cannot overwrite a later mutation', async () => {
  let resolveRead, resolveMutation;
  const client = fakeClient({ rpc: async (_name, params) => new Promise(resolve => {
    if (params.p_action === 'state') resolveRead = resolve; else resolveMutation = resolve;
  }) });
  const api = createLiveApi(config, { client });
  const read = api.state(); await settle();
  const mutation = api.mutate('next', { queue_id: 'queue-1', expected_revision: 1 }); await settle();
  await assert.rejects(api.mutate('next', {}), { code: 'BUSY' });
  resolveMutation({ data: fixture(2), error: null });
  assert.equal((await mutation).queues[0].revision, 2);
  resolveRead({ data: fixture(1), error: null });
  assert.equal((await read).queues[0].revision, 2);
});

test('Realtime listens only to safe group revisions and merges a burst into one refresh', async () => {
  const environment = watchEnvironment(), client = fakeClient();
  const api = createLiveApi(config, { client, ...environment });
  await api.login({});
  const observed = [];
  const unsubscribe = api.subscribe(data => observed.push(data)); await settle();
  const channel = client.channels[0];
  assert.deepEqual(channel.filter, {
    event: 'UPDATE', schema: 'public', table: 'group_revisions', filter: 'group_id=eq.group-1',
  });
  channel.callback(); channel.callback(); channel.callback();
  assert.equal([...environment.scheduled.values()].filter(timer => timer.delay === 180).length, 1);
  await environment.run(180);
  assert.equal(observed.length, 1);
  unsubscribe();
  assert.equal(environment.scheduled.size, 0);
  assert.equal(environment.handlers.size, 0);
});

test('hidden pages disconnect Realtime and never poll; returning refreshes and reconnects', async () => {
  const environment = watchEnvironment(), client = fakeClient();
  const api = createLiveApi(config, { client, ...environment });
  await api.login({});
  const unsubscribe = api.subscribe(() => {}); await settle();
  await environment.visibility('hidden');
  const reads = () => client.calls.filter(call => call[0] === 'rpc' && call[2].p_action === 'state').length;
  const before = reads();
  await environment.run(30000);
  assert.equal(reads(), before);
  await environment.visibility('visible');
  assert.equal(reads(), before + 1);
  assert.equal(client.channels.length, 2);
  client.channels.at(-1).status('SUBSCRIBED');
  await environment.run(30000);
  assert.equal(reads(), before + 1);
  unsubscribe();
});

test('fallback polling is visible only and logout removes its timer and local session', async () => {
  const environment = watchEnvironment(), client = fakeClient();
  const api = createLiveApi(config, { client, ...environment });
  await api.login({});
  const observed = [];
  api.subscribe(data => observed.push(data)); await settle();
  await environment.run(30000);
  assert.equal(observed.length, 1);
  await api.logout();
  assert.equal(environment.scheduled.size, 0);
  assert.equal(environment.handlers.size, 0);
  assert.deepEqual(client.calls.find(call => call[0] === 'signOut'), ['signOut', { scope: 'local' }]);
  assert.equal(await api.restore(), null);
});

test('SQL machine errors and missing deployment functions get safe human messages', async () => {
  assert.match(readableError({ code: 'P0001', message: 'COOLDOWN:4' }), /4 сек/);
  assert.match(readableError({ code: 'PGRST202', message: 'Could not find the function public.queue_api' }), /не настроена/);
  assert.doesNotMatch(readableError({ message: 'secret query: SELECT * FROM private.students' }), /SELECT|students/);
});
