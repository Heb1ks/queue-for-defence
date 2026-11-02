import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi, seedDemo } from '../src/demo.js';

const DATA_KEY = 'poryadok.demo.data.v1';
const NOW = Date.parse('2026-11-02T08:00:00.000Z');

function memoryStorage(initialData) {
  const items = new Map(initialData ? [[DATA_KEY, JSON.stringify(initialData)]] : []);
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
  };
}

function setup({ data, cooldownSeconds = 5, storage = memoryStorage(data) } = {}) {
  let now = NOW;
  const api = createDemoApi({ storage, clock: () => now, cooldownSeconds });
  return { api, storage, advance: (seconds = 5) => { now += seconds * 1000; } };
}

test('student can join different subjects, cannot duplicate enrollment, and leaving preserves the other subject', async () => {
  const { api, advance } = setup();
  let state = await api.mutate('join', { queue_id: 'demo-q-networks' });
  const mine = state.user.id;
  assert.ok(state.queues.find(queue => queue.id === 'demo-q-cloud').my_entry_id);
  assert.ok(state.queues.find(queue => queue.id === 'demo-q-networks').my_entry_id);
  advance();
  state = await api.mutate('join', { queue_id: 'demo-q-networks' });
  assert.equal(state.queues.find(queue => queue.id === 'demo-q-networks').entries.filter(entry => entry.student_id === mine).length, 1);
  advance();
  state = await api.mutate('leave', { queue_id: 'demo-q-networks' });
  assert.equal(state.queues.find(queue => queue.id === 'demo-q-networks').my_entry_id, null);
  assert.ok(state.queues.find(queue => queue.id === 'demo-q-cloud').my_entry_id);
});

test('next preserves order, retires the previous current entry, and rejects stale double-clicks', async () => {
  const { api, advance } = setup();
  const before = (await api.state()).queues.find(queue => queue.id === 'demo-q-cloud');
  const oldCurrent = before.current_entry_id;
  let state = await api.mutate('next', { queue_id: before.id, expected_revision: before.revision });
  let queue = state.queues.find(item => item.id === before.id);
  assert.equal(queue.current_entry_id, before.entries[1].id);
  assert.ok(!queue.entries.some(entry => entry.id === oldCurrent));
  assert.deepEqual(queue.entries.map(entry => entry.student_id), before.entries.slice(1).map(entry => entry.student_id));
  advance();
  await assert.rejects(api.mutate('next', { queue_id: before.id, expected_revision: before.revision }), { code: 'STALE_REVISION' });
  state = await api.mutate('next', { queue_id: before.id, expected_revision: queue.revision });
  queue = state.queues.find(item => item.id === before.id);
  assert.equal(queue.current_entry_id, before.entries[2].id);
});

test('removing current participant leaves next waiting for an explicit call', async () => {
  const { api, advance } = setup();
  const before = (await api.state()).queues.find(queue => queue.id === 'demo-q-cloud');
  const state = await api.mutate('remove_entry', { queue_id: before.id, entry_id: before.current_entry_id });
  const queue = state.queues.find(item => item.id === before.id);
  assert.equal(queue.current_entry_id, null);
  assert.ok(queue.entries.every(entry => !entry.is_current));
  assert.deepEqual(queue.entries.map(entry => entry.position), [1, 2, 3]);
  advance();
  const called = (await api.mutate('next', { queue_id: queue.id, expected_revision: queue.revision })).queues.find(item => item.id === queue.id);
  assert.equal(called.current_entry_id, queue.entries[0].id);
});

test('student management actions are denied and failed permission checks do not consume cooldown', async () => {
  const data = seedDemo(NOW); data.user.role = 'student';
  const { api } = setup({ data });
  for (const [action, payload] of [
    ['create_subject', { name: 'Databases' }], ['delete_subject', { subject_id: 'demo-cloud' }],
    ['next', { queue_id: 'demo-q-cloud', expected_revision: 1 }],
    ['remove_entry', { queue_id: 'demo-q-cloud', entry_id: 'demo-e1' }],
    ['close_queue', { queue_id: 'demo-q-cloud' }],
  ]) await assert.rejects(api.mutate(action, payload), { code: 'FORBIDDEN' });
  const state = await api.mutate('join', { queue_id: 'demo-q-networks' });
  assert.ok(state.queues.find(queue => queue.id === 'demo-q-networks').my_entry_id);
});

test('deleting a subject removes only its sessions and schedules', async () => {
  const { api } = setup();
  const before = await api.state();
  const result = await api.mutate('delete_subject', { subject_id: 'demo-cloud' });
  assert.ok(result.subjects.every(subject => subject.id !== 'demo-cloud'));
  assert.ok(result.queues.every(queue => queue.subject_id !== 'demo-cloud'));
  assert.ok(result.schedules.every(schedule => schedule.subject_id !== 'demo-cloud'));
  assert.deepEqual(result.queues.find(queue => queue.id === 'demo-q-networks'), before.queues.find(queue => queue.id === 'demo-q-networks'));
});

test('cooldown applies across subjects and failures do not restart the timer', async () => {
  const { api, advance } = setup();
  await assert.rejects(api.mutate('join', { queue_id: 'missing' }), { code: 'QUEUE_NOT_FOUND' });
  await api.mutate('join', { queue_id: 'demo-q-networks' });
  await assert.rejects(api.mutate('leave', { queue_id: 'demo-q-cloud' }), error => error.code === 'COOLDOWN' && error.retryAfter === 5);
  advance(4);
  await assert.rejects(api.mutate('leave', { queue_id: 'demo-q-cloud' }), error => error.code === 'COOLDOWN' && error.retryAfter === 1);
  advance(1);
  const state = await api.mutate('leave', { queue_id: 'demo-q-cloud' });
  assert.equal(state.queues.find(queue => queue.id === 'demo-q-cloud').my_entry_id, null);
});

test('future queues open and close by clock, and explicit closure stays closed', async () => {
  const { api, advance } = setup();
  await assert.rejects(api.mutate('join', { queue_id: 'demo-q-web' }), { code: 'QUEUE_NOT_OPEN' });
  advance(1320 * 60);
  let state = await api.mutate('join', { queue_id: 'demo-q-web' });
  assert.equal(state.queues.find(queue => queue.id === 'demo-q-web').status, 'open');
  advance(5);
  await api.mutate('close_queue', { queue_id: 'demo-q-web' });
  advance(60);
  state = await api.state();
  assert.equal(state.queues.find(queue => queue.id === 'demo-q-web').status, 'closed');
});

test('restore and logout keep data separate from the signed-in marker', async () => {
  const { api, storage } = setup();
  assert.equal(await api.restore(), null);
  await api.login();
  await api.mutate('create_subject', { name: 'Databases' });
  const restored = createDemoApi({ storage, clock: () => NOW });
  assert.ok((await restored.restore()).subjects.some(subject => subject.name === 'Databases'));
  await restored.logout();
  assert.equal(await restored.restore(), null);
  const later = createDemoApi({ storage, clock: () => NOW });
  assert.equal(await later.restore(), null);
  assert.ok((await later.login()).subjects.some(subject => subject.name === 'Databases'));
});

test('storage operation failures and corrupt stored data never break demo access', async () => {
  const blocked = {
    getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); },
    removeItem() { throw new Error('storage blocked'); },
  };
  const { api } = setup({ storage: blocked });
  assert.equal(await api.restore(), null);
  assert.ok((await api.login()).queues.length);
  await api.mutate('create_subject', { name: 'Databases' });
  await api.logout();
  const corrupt = { ...memoryStorage(), getItem: () => '{broken JSON' };
  assert.ok((await createDemoApi({ storage: corrupt, clock: () => NOW }).login()).queues.length);
});

test('a denied browser localStorage getter does not prevent creating the demo adapter', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    const api = createDemoApi({ clock: () => NOW });
    assert.ok((await api.login()).subjects.length);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('removing a missing enrollment reports a stale selection and does not consume cooldown', async () => {
  const { api } = setup();
  await assert.rejects(api.mutate('remove_entry', { queue_id: 'demo-q-cloud', entry_id: 'old-entry' }), { code: 'ENTRY_NOT_FOUND' });
  const state = await api.mutate('create_subject', { name: 'Databases' });
  assert.ok(state.subjects.some(subject => subject.name === 'Databases'));
});

test('invalid schedule numeric values never enter persisted demo data or consume cooldown', async () => {
  const { api } = setup();
  for (const invalid of [
    { opens_minutes_before: 'abc' }, { duration_minutes: 0 }, { duration_minutes: Infinity },
  ]) {
    await assert.rejects(api.mutate('save_schedule', { subject_id: 'demo-cloud', weekday: 4,
      local_time: '14:00', opens_minutes_before: 60, duration_minutes: 120, enabled: true, ...invalid }), { code: 'INVALID_SCHEDULE' });
  }
  const state = await api.mutate('create_subject', { name: 'Databases' });
  assert.ok(state.subjects.some(subject => subject.name === 'Databases'));
});

test('state snapshots are isolated and unsubscribed listeners stop receiving mutations', async () => {
  const { api, advance } = setup();
  const state = await api.state(); state.user.first_name = 'Mutated'; state.subjects.length = 0;
  assert.equal((await api.state()).user.first_name, 'Александр');
  assert.ok((await api.state()).subjects.length);
  const received = []; const unsubscribe = api.subscribe(value => received.push(value));
  await api.mutate('create_subject', { name: 'Databases' });
  assert.equal(received.length, 1);
  unsubscribe(); advance();
  await api.mutate('create_subject', { name: 'Algorithms' });
  assert.equal(received.length, 1);
});
