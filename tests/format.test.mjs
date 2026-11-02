import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, fullName, initials, formatTime, formatDate, localDateTime,
  zonedToISO, activeQueues, myQueues, ordinalPeople } from '../src/format.js';

test('student-provided names and attribute text are escaped before rendering', () => {
  const hostile = '<img src=x onerror="alert(1)"> & \'name\'';
  const escaped = escapeHtml(hostile);
  assert.equal(escaped, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;name&#39;');
  assert.equal(escapeHtml(123456), '123456');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(fullName({ first_name: '<b>A</b>', last_name: 'B' }), '<b>A</b> B');
  assert.equal(escapeHtml(fullName({ display_name: '<script>x</script>' })), '&lt;script&gt;x&lt;/script&gt;');
});

test('display names and initials work for Cyrillic and supplementary Unicode letters', () => {
  assert.equal(fullName({ first_name: 'Анна', last_name: 'Примерова' }), 'Анна Примерова');
  assert.equal(fullName({ display_name: 'Другое Имя', first_name: 'Ignored' }), 'Другое Имя');
  assert.equal(fullName({}), 'Участник');
  assert.equal(initials({ first_name: 'Анна', last_name: 'Примерова' }), 'АП');
  assert.equal(initials({ first_name: '𐐀test', last_name: 'Demo' }), '𐐀D');
});

test('Qyzylorda conversion uses the group timezone independently of host timezone', () => {
  assert.equal(localDateTime('2026-11-05T09:00:00.000Z', 'Asia/Qyzylorda'), '2026-11-05T14:00');
  assert.equal(zonedToISO('2026-11-05T14:00', 'Asia/Qyzylorda'), '2026-11-05T09:00:00.000Z');
  assert.equal(formatTime('2026-11-05T09:00:00.000Z'), '14:00');
  assert.equal(localDateTime('2026-11-04T20:15:00.000Z'), '2026-11-05T01:15');
  assert.match(formatDate('2026-11-04T20:15:00.000Z'), /5 ноября/);
});

test('invalid dates are rejected instead of scheduling a normalized different day', () => {
  for (const value of ['2026-02-30T14:00', '2026-13-01T14:00', '2026-11-05T25:00', '', '05.11.2026 14:00']) {
    assert.throws(() => zonedToISO(value));
  }
  assert.equal(formatTime('not-a-date'), '—');
  assert.equal(formatDate(undefined), '—');
});

test('active and personal queue filters preserve source order while returning chronological results', () => {
  const state = { queues: [
    { id: 'late', starts_at: '2026-11-05T15:00Z', status: 'open', my_entry_id: 'mine-2' },
    { id: 'archive', starts_at: '2026-11-05T08:00Z', status: 'archived', my_entry_id: 'mine-1' },
    { id: 'early', starts_at: '2026-11-05T09:00Z', status: 'upcoming', my_entry_id: null },
    { id: 'closed', starts_at: '2026-11-05T10:00Z', status: 'closed', my_entry_id: 'mine-3' },
  ] };
  assert.deepEqual(activeQueues(state).map(queue => queue.id), ['early', 'closed', 'late']);
  assert.deepEqual(myQueues(state).map(queue => queue.id), ['late']);
  assert.deepEqual(state.queues.map(queue => queue.id), ['late', 'archive', 'early', 'closed']);
  assert.deepEqual(myQueues(null), []);
});

test('people count labels follow Russian count rules', () => {
  assert.equal(ordinalPeople(1), '1 человек');
  assert.equal(ordinalPeople(2), '2 человека');
  assert.equal(ordinalPeople(5), '5 человек');
  assert.equal(ordinalPeople(11), '11 человек');
  assert.equal(ordinalPeople(24), '24 человека');
  assert.equal(ordinalPeople(25), '25 человек');
});
