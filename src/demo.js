import { fullName } from './format.js';

const DATA_KEY = 'poryadok.demo.data.v1';
const SESSION_KEY = 'poryadok.demo.session.v1';
const copy = value => JSON.parse(JSON.stringify(value));
function problem(code, message, retryAfter = 0) {
  const error = new Error(message); error.code = code; error.retryAfter = retryAfter; return error;
}
function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function seedDemo(now = Date.now()) {
  const iso = minutes => new Date(now + minutes * 60_000).toISOString();
  const user = { id: 'demo-me', first_name: 'Александр', last_name: 'Примеров', group_code: 'SE-2421', role: 'admin' };
  const people = [
    { id: 'demo-anna', first_name: 'Анна', last_name: 'Примерова' },
    { id: 'demo-max', first_name: 'Максим', last_name: 'Примеров' },
    { id: 'demo-sofia', first_name: 'София', last_name: 'Демо' },
    { id: 'demo-artem', first_name: 'Артём', last_name: 'Демо' },
    user,
  ];
  const entry = (person, id) => ({ id, student_id: person.id, first_name: person.first_name, last_name: person.last_name });
  return {
    user, group: { id: 'demo-group', code: 'SE-2421', timezone: 'Asia/Qyzylorda', member_count: 25 },
    subjects: [{ id: 'demo-cloud', name: 'Cloud Computing' }, { id: 'demo-networks', name: 'Computer Networks' },
      { id: 'demo-web', name: 'Web Technologies' }],
    queues: [
      { id: 'demo-q-cloud', subject_id: 'demo-cloud', title: 'Защита лабораторной работы', starts_at: iso(20),
        opens_at: iso(-120), closes_at: iso(140), status: 'open', current_entry_id: 'demo-e1', revision: 1,
        entries: [entry(people[0], 'demo-e1'), entry(people[1], 'demo-e2'), entry(user, 'demo-e3'), entry(people[2], 'demo-e4')] },
      { id: 'demo-q-networks', subject_id: 'demo-networks', title: 'Практическое занятие', starts_at: iso(80),
        opens_at: iso(-30), closes_at: iso(200), status: 'open', current_entry_id: null, revision: 0,
        entries: [entry(people[3], 'demo-e5'), entry(people[0], 'demo-e6')] },
      { id: 'demo-q-web', subject_id: 'demo-web', title: 'Защита проекта', starts_at: iso(1440),
        opens_at: iso(1320), closes_at: iso(1560), status: 'upcoming', current_entry_id: null, revision: 0, entries: [] },
    ],
    schedules: [
      { id: 'demo-s1', subject_id: 'demo-cloud', subject_name: 'Cloud Computing', weekday: 3, local_time: '15:00', opens_minutes_before: 60, duration_minutes: 120, enabled: true },
      { id: 'demo-s2', subject_id: 'demo-networks', subject_name: 'Computer Networks', weekday: 4, local_time: '14:00', opens_minutes_before: 120, duration_minutes: 120, enabled: true },
    ],
  };
}

export function createDemoApi({ storage = browserStorage(), clock = Date.now, cooldownSeconds = 5 } = {}) {
  let data;
  try { data = JSON.parse(storage?.getItem(DATA_KEY) || 'null'); } catch { /* Start clean after corrupt browser data. */ }
  if (!data?.user || !Array.isArray(data.queues) || !Array.isArray(data.subjects)) data = seedDemo(clock());
  let lastMutation = -Infinity;
  const listeners = new Set();
  const persist = () => { try { storage?.setItem(DATA_KEY, JSON.stringify(data)); } catch { /* Demo may run without browser storage. */ } };
  const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const state = () => {
    const result = copy(data);
    for (const queue of result.queues) {
      queue.subject_name = result.subjects.find(subject => subject.id === queue.subject_id)?.name || 'Предмет';
      if (!['closed', 'archived'].includes(queue.status)) {
        queue.status = clock() < Date.parse(queue.opens_at) ? 'upcoming' : clock() >= Date.parse(queue.closes_at) ? 'closed' : 'open';
      }
      const current = queue.entries.find(entry => entry.id === queue.current_entry_id);
      const ordered = [...(current ? [current] : []), ...queue.entries.filter(entry => entry !== current)];
      let waiting = 0;
      queue.entries = ordered.map(entry => ({ ...entry, display_name: fullName(entry), is_current: entry === current,
        position: entry === current ? 0 : ++waiting }));
      const mine = queue.entries.find(entry => entry.student_id === result.user.id);
      queue.my_entry_id = mine?.id || null; queue.my_position = mine?.position ?? null;
      queue.waiting_count = waiting; queue.current_student_id = current?.student_id || null;
    }
    return result;
  };
  const requireAdmin = () => { if (data.user.role !== 'admin') throw problem('FORBIDDEN', 'Это действие доступно администратору.'); };
  return {
    mode: 'demo', isConfigured: true,
    async login() { try { storage?.setItem(SESSION_KEY, 'yes'); } catch { /* Storage is optional. */ } return state(); },
    async restore() { try { return storage?.getItem(SESSION_KEY) === 'yes' ? state() : null; } catch { return null; } },
    async state() { return state(); },
    async mutate(action, payload = {}) {
      const remaining = Math.ceil((lastMutation + cooldownSeconds * 1000 - clock()) / 1000);
      if (remaining > 0) throw problem('COOLDOWN', `Подожди ещё ${remaining} сек.`, remaining);
      const queue = data.queues.find(item => item.id === payload.queue_id);
      const subject = data.subjects.find(item => item.id === payload.subject_id);
      const queueActions = ['join', 'leave', 'next', 'remove_entry', 'close_queue', 'archive_queue'];
      if (queueActions.includes(action) && !queue) throw problem('QUEUE_NOT_FOUND', 'Очередь не найдена.');
      if (!['join', 'leave'].includes(action)) requireAdmin();
      if (action === 'join') {
        if (state().queues.find(item => item.id === queue.id).status !== 'open') throw problem('QUEUE_NOT_OPEN', 'Запись в эту очередь сейчас закрыта.');
        if (!queue.entries.some(entry => entry.student_id === data.user.id)) {
          queue.entries.push({ id: id('entry'), student_id: data.user.id, first_name: data.user.first_name, last_name: data.user.last_name });
          queue.revision++;
        }
      } else if (action === 'leave') {
        const mine = queue.entries.find(entry => entry.student_id === data.user.id);
        if (mine?.id === queue.current_entry_id) throw problem('CURRENT_CANNOT_LEAVE', 'Сейчас твоя защита. Следующего вызывает администратор.');
        queue.entries = queue.entries.filter(entry => entry.student_id !== data.user.id); queue.revision++;
      } else if (action === 'next') {
        if (payload.expected_revision !== queue.revision) throw problem('STALE_REVISION', 'Очередь обновилась. Проверь порядок и повтори действие.');
        if (state().queues.find(item => item.id === queue.id).status !== 'open') throw problem('QUEUE_NOT_OPEN', 'Очередь закрыта.');
        queue.entries = queue.entries.filter(entry => entry.id !== queue.current_entry_id);
        queue.current_entry_id = queue.entries[0]?.id || null; queue.revision++;
      } else if (action === 'remove_entry') {
        if (!queue.entries.some(entry => entry.id === payload.entry_id)) throw problem('ENTRY_NOT_FOUND', 'Этой записи уже нет в очереди.');
        queue.entries = queue.entries.filter(entry => entry.id !== payload.entry_id);
        if (queue.current_entry_id === payload.entry_id) queue.current_entry_id = null;
        queue.revision++;
      } else if (action === 'close_queue' || action === 'archive_queue') {
        queue.status = action === 'close_queue' ? 'closed' : 'archived'; queue.revision++;
      } else if (action === 'create_subject') {
        const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 60) throw problem('INVALID_NAME', 'Название должно содержать от 1 до 60 символов.');
        if (data.subjects.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw problem('SUBJECT_EXISTS', 'Этот предмет уже есть.');
        data.subjects.push({ id: id('subject'), name });
      } else if (action === 'delete_subject') {
        if (!subject) throw problem('SUBJECT_NOT_FOUND', 'Предмет не найден.');
        data.subjects = data.subjects.filter(item => item.id !== subject.id);
        data.queues = data.queues.filter(item => item.subject_id !== subject.id);
        data.schedules = data.schedules.filter(item => item.subject_id !== subject.id);
      } else if (action === 'create_queue') {
        if (!subject) throw problem('SUBJECT_NOT_FOUND', 'Сначала создай предмет.');
        const starts = Date.parse(payload.starts_at);
        const opens = payload.opens_at ? Date.parse(payload.opens_at) : clock();
        const closes = payload.closes_at ? Date.parse(payload.closes_at) : starts + 120 * 60_000;
        if (![starts, opens, closes].every(Number.isFinite) || closes <= starts || closes <= opens) throw problem('INVALID_TIME', 'Проверь даты открытия и закрытия очереди.');
        data.queues.push({ id: id('queue'), subject_id: subject.id, title: payload.title || 'Защита работы',
          starts_at: new Date(starts).toISOString(), opens_at: new Date(opens).toISOString(), closes_at: new Date(closes).toISOString(),
          status: 'open', current_entry_id: null, revision: 0, entries: [] });
      } else if (action === 'save_schedule') {
        if (!subject || !Number.isInteger(Number(payload.weekday)) || payload.weekday < 1 || payload.weekday > 7 ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.local_time)) throw problem('INVALID_SCHEDULE', 'Проверь предмет, день недели и время.');
        const item = { ...payload, id: payload.id || id('schedule'), subject_name: subject.name, weekday: Number(payload.weekday),
          opens_minutes_before: Number(payload.opens_minutes_before ?? 120), duration_minutes: Number(payload.duration_minutes ?? 120), enabled: payload.enabled !== false };
        if (!Number.isInteger(item.opens_minutes_before) || !Number.isInteger(item.duration_minutes) ||
            item.opens_minutes_before < 0 || item.opens_minutes_before > 10080 ||
            item.duration_minutes < 15 || item.duration_minutes > 1440) throw problem('INVALID_SCHEDULE', 'Проверь время открытия записи и длительность занятия.');
        data.schedules = [...data.schedules.filter(existing => existing.id !== item.id), item];
      } else if (action === 'delete_schedule') {
        data.schedules = data.schedules.filter(item => item.id !== payload.schedule_id);
      } else {
        throw problem('UNKNOWN_ACTION', 'Неизвестное действие.');
      }
      lastMutation = clock(); persist(); const fresh = state();
      for (const listener of listeners) listener(fresh);
      return fresh;
    },
    async logout() { try { storage?.removeItem(SESSION_KEY); } catch { /* No storage. */ } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { listeners.clear(); },
  };
}
