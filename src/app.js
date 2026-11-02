import config from '../config.js';
import { createLiveApi, readableError } from './api.js';
import { createDemoApi } from './demo.js';
import { escapeHtml as h, fullName, initials, formatTime, formatDate, localDateTime, zonedToISO,
  activeQueues, myQueues, ordinalPeople, WEEKDAYS, WEEKDAYS_SHORT } from './format.js';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const live = createLiveApi(config, { onStatus: updateConnection });
let api = live, state = null, view = 'mine', pending = false, cooldownUntil = 0, unsubscribe;
let dialogState = null, confirmCallback = null, queueFilter = 'all', queueSearch = '';
const dialog = $('#app-dialog');
const headings = {
  mine: ['ВАША УЧЁБА БЕЗ СУЕТЫ', 'Мои очереди', 'Ваше место и всё, что нужно знать перед защитой.'],
  queues: ['ОДНА ГРУППА. ОБЩИЙ ПОРЯДОК.', 'Все очереди', 'Выберите предмет и запишитесь на ближайшую защиту.'],
  schedule: ['ПЛАН НА НЕДЕЛЮ', 'Расписание', 'Занятия группы и время открытия записи.'],
  admin: ['ДЛЯ АДМИНИСТРАТОРА', 'Управление', 'Предметы, очереди и повторяющиеся занятия группы.'],
};
const isAdmin = () => state?.user?.role === 'admin';
const tz = () => state?.group?.timezone || config.timezone;
const queueById = id => state?.queues?.find(queue => queue.id === id);

function button(text, action, id = '', { primary = false, danger = false, mutation = false, extra = '', disabled = false } = {}) {
  return `<button type="button" class="button ${primary ? 'button-primary' : danger ? 'button-danger' : 'button-secondary'}" data-action="${action}" data-id="${h(id)}" ${mutation ? 'data-mutation' : ''} ${disabled ? 'disabled data-base-disabled="true"' : ''} ${extra}><span data-button-label>${h(text)}</span></button>`;
}
function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' toast-error' : ''}`;
  element.textContent = message;
  let region = $('#toast-region');
  if (dialog.open) {
    region = dialog.querySelector('.dialog-feedback');
    if (!region) { region = document.createElement('div'); region.className = 'dialog-feedback'; region.setAttribute('role', 'status'); dialog.append(region); }
  }
  region.append(element);
  setTimeout(() => element.remove(), 5000);
}
function errorText(error) {
  if (error?.code && error?.name !== 'AppError' && error?.message) return error.message;
  if (error instanceof Error && !error.code && !/fetch|network/i.test(error.message)) return error.message;
  return readableError(error);
}
function updateConnection(status) {
  const element = $('#connection-status');
  if (!element) return;
  const current = api?.mode === 'demo' ? 'demo' : status;
  element.textContent = ({ online: 'Синхронизировано', connecting: 'Подключение…', offline: 'Нет связи', demo: 'Демо-режим' })[current] || 'Подключение…';
  element.dataset.status = current;
}
function setView(next, focus = false) {
  view = headings[next] && (next !== 'admin' || isAdmin()) ? next : 'mine';
  if (location.hash !== `#/${view}`) history.replaceState(null, '', `#/${view}`);
  render();
  if (focus) $('#main-content').focus({ preventScroll: true });
}
function updateCooldown() {
  const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  document.querySelectorAll('[data-mutation]').forEach(element => {
    if (!element.dataset.baseDisabled) element.disabled = pending || remaining > 0;
    const label = element.querySelector('[data-button-label]');
    if (!label) return;
    if (!label.dataset.base) label.dataset.base = label.textContent;
    label.textContent = pending ? 'Сохраняем…' : remaining > 0 ? `${label.dataset.base} · ${remaining} с` : label.dataset.base;
  });
}
async function mutate(action, payload, success, onDone) {
  if (pending) return;
  if (cooldownUntil > Date.now()) { toast('Между действиями нужно подождать 5 секунд.'); return; }
  pending = true; updateCooldown();
  try {
    const fresh = await api.mutate(action, payload);
    cooldownUntil = Date.now() + 5000;
    applyState(fresh);
    if (success) toast(success);
    if (onDone) onDone();
  } catch (error) {
    if (error.retryAfter) cooldownUntil = Date.now() + error.retryAfter * 1000;
    toast(errorText(error), true);
    if (['STALE_QUEUE', 'STALE_REVISION', 'QUEUE_CHANGED', 'ENTRY_NOT_FOUND', 'QUEUE_NOT_FOUND'].includes(error.code)) {
      try { applyState(await api.state()); } catch { /* Keep the previous visible state while offline. */ }
    }
    if (['SESSION_EXPIRED', 'UNAUTHENTICATED', 'NOT_REGISTERED'].includes(error.code)) await signOut();
  } finally { pending = false; updateCooldown(); }
}
function applyState(fresh) {
  if (!fresh?.user || !fresh?.group || !Array.isArray(fresh.queues)) throw new Error('Не удалось прочитать данные группы.');
  state = fresh; render();
  if (dialog.open && dialogState?.kind === 'queue') {
    const queue = queueById(dialogState.id);
    if (queue) renderQueueDialog(queue); else closeDialog();
  }
}
async function enter(nextApi, fresh) {
  unsubscribe?.(); api = nextApi; state = fresh; cooldownUntil = 0;
  $('#auth-screen').hidden = true; $('#app-shell').hidden = false;
  $('#demo-banner').hidden = api.mode !== 'demo';
  const initial = location.hash.replace('#/', '');
  setView(headings[initial] ? initial : myQueues(state).length ? 'mine' : 'queues');
  updateConnection(api.mode === 'demo' ? 'demo' : 'connecting');
  unsubscribe = api.subscribe(freshState => applyState(freshState), error => { updateConnection('offline'); console.warn(error?.code || 'NETWORK'); });
}
async function signOut() {
  unsubscribe?.(); unsubscribe = null; closeDialog();
  try { await api.logout(); } catch { /* A local sign-out still closes the cabinet. */ }
  if (api.mode === 'demo') api.destroy();
  api = live; state = null; $('#app-shell').hidden = true; $('#auth-screen').hidden = false;
  $('#auth-status').textContent = ''; $('#login-form').elements.student_code.value = '';
  history.replaceState(null, '', location.pathname + location.search);
}
function stats() {
  const mine = myQueues(state), queues = activeQueues(state);
  const next = mine.find(queue => queue.status === 'open') || mine[0];
  return `<div class="stats-grid">
    <article class="stat-card"><span class="stat-label">Мои очереди</span><strong class="stat-value">${mine.length.toString().padStart(2, '0')}</strong><span class="stat-note">${mine.length ? 'Ваши активные записи' : 'Самое время записаться'}</span></article>
    <article class="stat-card"><span class="stat-label">Открыта запись</span><strong class="stat-value">${queues.filter(queue => queue.status === 'open').length.toString().padStart(2, '0')}</strong><span class="stat-note">Очереди вашей группы</span></article>
    <article class="stat-card"><span class="stat-label">Ближайшая защита</span><strong class="stat-value">${next ? formatTime(next.starts_at, tz()) : '—'}</strong><span class="stat-note">${next ? h(formatDate(next.starts_at, tz())) : 'Пока нет записей'}</span></article>
    <article class="stat-card"><span class="stat-label">Наша группа</span><strong class="stat-value">${Number(state.group.member_count || 0)}</strong><span class="stat-note">${h(state.group.code)} · вместе к результату</span></article>
  </div>`;
}
function statusLabel(queue) {
  return queue.status === 'open' ? '<span class="badge badge-green"><span class="tiny-dot"></span> Запись открыта</span>' :
    queue.status === 'upcoming' ? '<span class="badge badge-amber">Скоро откроется</span>' : '<span class="badge badge-muted">Завершена</span>';
}
function queueCard(queue) {
  const mine = Boolean(queue.my_entry_id), current = queue.entries.find(entry => entry.is_current);
  const myTurn = mine && queue.my_position === 0;
  const before = mine && !myTurn ? Math.max(0, queue.my_position - 1) : 0;
  return `<article class="queue-card${mine ? ' queue-card-mine' : ''}">
    <div class="queue-card-header"><span class="subject-icon">${icon(/network/i.test(queue.subject_name) ? 'users' : /cloud/i.test(queue.subject_name) ? 'grid' : 'list')}</span>${statusLabel(queue)}</div>
    <div><h2 class="queue-title">${h(queue.subject_name)}</h2><p class="queue-meta">${h(queue.title || 'Защита работы')}</p></div>
    <div class="queue-meta">${icon('calendar')} ${h(formatDate(queue.starts_at, tz(), true))}<span aria-hidden="true"> · </span>${formatTime(queue.starts_at, tz())}</div>
    ${mine ? `<div class="position-badge"><span>${myTurn ? 'Сейчас ваша защита' : 'Ваше место в очереди'}</span><strong>${myTurn ? '↗' : String(queue.my_position).padStart(2, '0')}</strong></div>
      <div class="queue-progress" aria-hidden="true"><span style="width:${myTurn ? 100 : Math.max(8, Math.round(100 / Math.max(1, queue.my_position)))}%"></span></div>
      <p class="small muted">${myTurn ? 'Покажите работу преподавателю. Удачи!' : before ? `Перед вами ${ordinalPeople(before)}${current ? ' и текущая защита' : ''}. Можно готовиться.` : current ? 'Вы следующие — проверьте, всё ли готово.' : 'Вы первые. Администратор начнёт защиту.'}</p>` :
      `<div class="queue-current"><span class="small muted">${current ? 'Сейчас защищается' : 'В очереди'}</span><strong>${current ? h(fullName(current)) : ordinalPeople(queue.waiting_count)}</strong></div>`}
    <div class="queue-footer"><span class="small muted">${queue.status === 'upcoming' ? `Запись с ${formatTime(queue.opens_at, tz())}` : `Ожидают: ${ordinalPeople(queue.waiting_count)}`}</span>
      <div class="action-row">${button(mine ? 'Моя очередь ↗' : 'Открыть', 'open-queue', queue.id, { primary: mine })}
      ${!mine && queue.status === 'open' ? button('Вступить', 'join', queue.id, { primary: true, mutation: true }) : ''}</div></div>
  </article>`;
}
function empty(title, description, action = '') {
  return `<div class="empty-state"><span class="empty-icon">${icon('list')}</span><h2>${h(title)}</h2><p>${h(description)}</p>${action}</div>`;
}
function scheduleCards(schedules, compact = false) {
  return schedules.map(schedule => `<article class="schedule-card"><span class="weekday-badge">${WEEKDAYS_SHORT[schedule.weekday - 1]}<small>${h(schedule.local_time)}</small></span>
    <div class="schedule-info"><strong>${h(schedule.subject_name)}</strong><span>${WEEKDAYS[schedule.weekday - 1]} · запись за ${Number(schedule.opens_minutes_before)} мин.</span></div>
    ${!schedule.enabled ? '<span class="badge badge-muted">На паузе</span>' : '<span class="badge badge-green">Еженедельно</span>'}
    ${isAdmin() && !compact ? `<div class="action-row">${button('Изменить', 'edit-schedule', schedule.id)}${button('Удалить', 'delete-schedule', schedule.id, { danger: true })}</div>` : ''}</article>`).join('');
}
function renderMine() {
  const mine = myQueues(state);
  return `${stats()}<div class="section-head"><div><h2 class="section-title">Ваши ближайшие защиты</h2><p class="section-description">Место сохраняется — держать страницу открытой не обязательно.</p></div>${button('Все очереди ↗', 'goto-queues')}</div>
    ${mine.length ? `<div class="queue-grid">${mine.map(queueCard).join('')}</div>` : empty('Вы пока никуда не записаны', 'Откройте очереди группы и выберите нужную защиту.', button('Найти очередь', 'goto-queues', '', { primary: true }))}
    <div class="section-head"><div><h2 class="section-title">В течение недели</h2><p class="section-description">Повторяющиеся занятия вашей группы.</p></div>${button('Всё расписание ↗', 'goto-schedule')}</div>
    ${state.schedules.some(schedule => schedule.enabled) ? `<div class="schedule-list">${scheduleCards(state.schedules.filter(schedule => schedule.enabled).slice(0, 3), true)}</div>` : '<div class="notice">Активного расписания пока нет. Следите за очередями, которые открывает администратор.</div>'}`;
}
function filteredQueues() {
  return activeQueues(state).filter(queue => (queueFilter === 'all' || queue.status === queueFilter) &&
    `${queue.subject_name} ${queue.title}`.toLocaleLowerCase().includes(queueSearch.toLocaleLowerCase()));
}
function renderQueueResults() {
  const queues = filteredQueues();
  return queues.length ? `<div class="queue-grid">${queues.map(queueCard).join('')}</div>` : empty('Очередей пока нет',
    queueSearch || queueFilter !== 'all' ? 'Попробуйте другой фильтр или название предмета.' : isAdmin() ? 'Создайте первую очередь на конкретное занятие.' : 'Администратор откроет запись перед защитой.',
    isAdmin() && !queueSearch && queueFilter === 'all' ? button('Создать очередь', 'create-queue', '', { primary: true }) : '');
}
function renderQueues() {
  return `<div class="queue-toolbar"><div class="segmented" aria-label="Статус очереди">${[['all', 'Все'], ['open', 'Запись открыта'], ['upcoming', 'Предстоящие'], ['closed', 'Завершённые']].map(([value, text]) => `<button type="button" data-filter="${value}" class="${queueFilter === value ? 'is-active' : ''}" aria-pressed="${queueFilter === value}">${text}</button>`).join('')}</div>
    <input id="queue-search" class="input queue-search" type="search" placeholder="Найти предмет…" aria-label="Найти предмет" value="${h(queueSearch)}"></div><div id="queue-results">${renderQueueResults()}</div>`;
}
function renderSchedule() {
  const sorted = [...state.schedules].sort((a, b) => a.weekday - b.weekday || a.local_time.localeCompare(b.local_time));
  return `<div class="notice">${icon('clock')} Время занятий указано в часовом поясе группы: ${h(tz())}. На каждое занятие создаётся отдельная очередь.</div>
    <div class="section-head"><div><h2 class="section-title">Недельное расписание</h2><p class="section-description">Запись открывается автоматически до начала занятия.</p></div></div>
    ${sorted.length ? `<div class="schedule-list">${scheduleCards(sorted)}</div>` : empty('Здесь появится расписание', isAdmin() ? 'Добавьте предмет, день недели и время открытия записи.' : 'Администратор ещё не добавил повторяющиеся занятия.', isAdmin() ? button('Добавить занятие', 'create-schedule', '', { primary: true }) : '')}`;
}
function renderAdmin() {
  return `<div class="card"><div class="card-header"><div><h2 class="section-title">Предметы группы</h2><p class="section-description">Название предмета объединяет его занятия и очереди.</p></div>${button('Добавить предмет', 'create-subject', '', { primary: true })}</div>
    ${state.subjects.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Предмет</th><th>Очереди</th><th><span class="visually-hidden">Действия</span></th></tr></thead><tbody>${state.subjects.map(subject => `<tr><td><strong>${h(subject.name)}</strong></td><td>${state.queues.filter(queue => queue.subject_id === subject.id).length}</td><td><div class="action-row">${button('Создать очередь', 'create-queue', subject.id)}${button('Удалить', 'delete-subject', subject.id, { danger: true })}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="card-body muted">Добавьте первый предмет, затем создайте очередь или расписание.</div>'}</div>
    <div class="section-head"><div><h2 class="section-title">Доступ и порядок</h2><p class="section-description">Действия администратора применяются ко всей группе.</p></div></div>
    <div class="card-grid"><article class="card card-body"><span class="subject-icon">${icon('shield')}</span><h3>Студенты группы</h3><p class="muted">В списке группы — ${ordinalPeople(Number(state.group.member_count || 0))}. Каждый входит по своим данным и индивидуальному коду студента.</p><p class="small muted">Добавление студентов выполняется владельцем через защищённый импорт базы. Коды студентов не публикуются на сайте.</p></article>
    <article class="card card-body"><span class="subject-icon">${icon('clock')}</span><h3>Пауза между действиями</h3><p class="muted">5 секунд на человека — для записи, выхода и действий администратора. Проверка работает на сервере и на сайте.</p><p class="small muted">Текущее место закреплено за студентом, поэтому вход с другого устройства не создаёт повторную запись.</p></article></div>`;
}
function render() {
  if (!state) return;
  if (view === 'admin' && !isAdmin()) view = 'mine';
  $('#user-name').textContent = fullName(state.user); $('#user-role').textContent = isAdmin() ? 'Администратор группы' : 'Участник группы';
  $('#user-avatar').textContent = initials(state.user);
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin(); });
  document.querySelectorAll('[data-view]').forEach(element => {
    const active = element.dataset.view === view; element.classList.toggle('is-active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  const heading = headings[view];
  $('#page-eyebrow').textContent = heading[0]; $('#page-title').textContent = heading[1]; $('#page-description').textContent = heading[2];
  $('#page-actions').innerHTML = view === 'schedule' && isAdmin() ? button('Добавить занятие', 'create-schedule', '', { primary: true }) :
    view === 'queues' && isAdmin() ? button('Создать очередь', 'create-queue', '', { primary: true }) : button('Обновить', 'refresh');
  $('#app-content').innerHTML = ({ mine: renderMine, queues: renderQueues, schedule: renderSchedule, admin: renderAdmin })[view]();
  document.title = `${heading[1]} · Порядок`;
  updateCooldown();
}
function showDialog(html, kind = 'form', id = '') {
  dialogState = { kind, id }; $('#dialog-content').innerHTML = html;
  if (!dialog.open) dialog.showModal();
  updateCooldown();
}
function closeDialog() { dialog.close(); dialogState = null; confirmCallback = null; }
function renderQueueDialog(queue) {
  const current = queue.entries.find(entry => entry.is_current);
  const mine = queue.my_entry_id;
  $('#dialog-content').innerHTML = `<p class="eyebrow">${h(formatDate(queue.starts_at, tz(), true))} · ${formatTime(queue.starts_at, tz())}</p><h2 class="dialog-title">${h(queue.subject_name)}</h2><p class="dialog-description">${h(queue.title)}</p>
    <div class="action-row dialog-badges">${statusLabel(queue)}<span class="badge badge-muted">Ожидают: ${ordinalPeople(queue.waiting_count)}</span></div>
    ${mine ? `<div class="notice">${queue.my_position === 0 ? 'Сейчас ваша защита. Удачи!' : `Ваше место: ${queue.my_position}. ${queue.my_position === 1 ? 'Вы следующие — можно готовиться.' : 'Ваше место сохранено.'}`}</div>` : ''}
    <div class="queue-members">${queue.entries.length ? queue.entries.map(entry => `<div class="member-row${entry.is_current ? ' member-current' : ''}${entry.student_id === state.user.id ? ' member-mine' : ''}">
      <span class="member-number">${entry.is_current ? icon('arrow-right') : String(entry.position).padStart(2, '0')}</span><span class="member-avatar">${h(initials(entry))}</span>
      <div class="member-info"><span class="member-name">${h(fullName(entry))}${entry.student_id === state.user.id ? ' <small>· вы</small>' : ''}</span><span class="member-caption">${entry.is_current ? 'Сейчас защищается' : entry.position === 1 ? 'Готовится следующим' : 'Ожидает'}</span></div>
      ${isAdmin() ? `<button class="icon-button" type="button" data-action="remove-entry" data-id="${h(queue.id)}" data-entry-id="${h(entry.id)}" aria-label="Убрать ${h(fullName(entry))}" title="Убрать из очереди">${icon('close')}</button>` : ''}</div>`).join('') : '<div class="empty-state small"><p>Пока никто не записался. Можно быть первым.</p></div>'}</div>
    <div class="form-actions">${!mine && queue.status === 'open' ? button('Вступить в очередь', 'join', queue.id, { primary: true, mutation: true }) : mine && queue.my_position !== 0 ? button('Выйти из очереди', 'leave', queue.id, { mutation: true }) : ''}
      ${isAdmin() && queue.status === 'open' ? button(current ? 'Следующий' : 'Начать защиту', 'next', queue.id, { primary: true, mutation: true, extra: `data-revision="${queue.revision}"`, disabled: !queue.entries.length }) : ''}</div>
    ${isAdmin() ? `<div class="dialog-admin-actions"><span class="small muted">Управление очередью</span><div class="action-row">${queue.status !== 'closed' ? button('Закрыть запись', 'close-queue', queue.id) : ''}${button('В архив', 'archive-queue', queue.id)}</div></div>` : ''}`;
  updateCooldown();
}
function openQueue(id) {
  const queue = queueById(id);
  if (!queue) { toast('Очередь уже недоступна.', true); return; }
  showDialog('', 'queue', id); renderQueueDialog(queue);
}
function confirmAction(title, description, label, action, payload, onDone) {
  confirmCallback = () => mutate(action, payload, 'Готово. Изменения сохранены.', () => { closeDialog(); onDone?.(); });
  showDialog(`<p class="eyebrow">ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ</p><h2 class="dialog-title">${h(title)}</h2><p class="dialog-description">${h(description)}</p><div class="form-actions">${button('Отмена', 'close-dialog')}${button(label, 'confirm', '', { danger: true, mutation: true })}</div>`, 'confirm');
}
function subjectOptions(selected = '') {
  return state.subjects.map(subject => `<option value="${h(subject.id)}" ${subject.id === selected ? 'selected' : ''}>${h(subject.name)}</option>`).join('');
}
function field(label, html, hint = '') { return `<label class="field"><span class="field-label">${label}</span>${html}${hint ? `<span class="field-hint">${hint}</span>` : ''}</label>`; }
function formFooter(label) {
  return `<div class="form-actions">${button('Отмена', 'close-dialog')}<button class="button button-primary" type="submit" data-mutation><span data-button-label>${label}</span></button></div>`;
}
function openSubjectForm() {
  showDialog(`<p class="eyebrow">ПРЕДМЕТЫ ГРУППЫ</p><h2 class="dialog-title">Добавить предмет</h2><p class="dialog-description">После создания можно открыть очередь и настроить занятия.</p><form data-form="subject">${field('Название предмета', '<input class="input" name="name" placeholder="Например, Cloud Computing" maxlength="60" required autofocus>')}${formFooter('Добавить предмет')}</form>`);
}
function requireSubjects() {
  if (state.subjects.length) return true;
  toast('Сначала добавьте хотя бы один предмет.'); openSubjectForm(); return false;
}
function openQueueForm(subjectId = '') {
  if (!requireSubjects()) return;
  const starts = localDateTime(Date.now() + 60 * 60_000, tz());
  showDialog(`<p class="eyebrow">НОВОЕ ЗАНЯТИЕ</p><h2 class="dialog-title">Создать очередь</h2><p class="dialog-description">Очередь относится к конкретной дате. Время: ${h(tz())}.</p><form data-form="queue"><div class="form-grid">
    ${field('Предмет', `<select class="select" name="subject_id" required>${subjectOptions(subjectId)}</select>`)}
    ${field('Название защиты', '<input class="input" name="title" placeholder="Защита лабораторной работы" maxlength="120" required>')}
    ${field('Начало занятия', `<input class="input" type="datetime-local" name="starts_at" value="${starts}" required>`)}
    ${field('Запись открывается', `<input class="input" type="datetime-local" name="opens_at" value="${localDateTime(Date.now(), tz())}" required>`)}
    ${field('Длительность, минут', '<input class="input" type="number" name="duration_minutes" value="120" min="15" max="1440" step="5" required>')}
    </div><p class="field-hint">Во время открытой записи студенты смогут занять место.</p>${formFooter('Создать очередь')}</form>`);
}
function openScheduleForm(id = '') {
  if (!requireSubjects()) return;
  const item = state.schedules.find(schedule => schedule.id === id);
  showDialog(`<p class="eyebrow">ПОВТОРЯЮЩЕЕСЯ ЗАНЯТИЕ</p><h2 class="dialog-title">${item ? 'Изменить занятие' : 'Добавить в расписание'}</h2><p class="dialog-description">Каждую неделю появится новая очередь. Время: ${h(tz())}.</p>
    <form data-form="schedule" data-id="${h(id)}"><div class="form-grid">
    ${field('Предмет', `<select class="select" name="subject_id" required>${subjectOptions(item?.subject_id)}</select>`)}
    ${field('День недели', `<select class="select" name="weekday">${WEEKDAYS.map((name, index) => `<option value="${index + 1}" ${(item?.weekday || 4) === index + 1 ? 'selected' : ''}>${name}</option>`).join('')}</select>`)}
    ${field('Начало занятия', `<input class="input" type="time" name="local_time" value="${h(item?.local_time || '14:00')}" required>`)}
    ${field('Открыть запись за, минут', `<input class="input" type="number" name="opens_minutes_before" value="${Number(item?.opens_minutes_before ?? 120)}" min="0" max="10080" required>`)}
    ${field('Длительность, минут', `<input class="input" type="number" name="duration_minutes" value="${Number(item?.duration_minutes || 120)}" min="15" max="1440" required>`)}
    ${field('Автоматическое создание', `<select class="select" name="enabled"><option value="true" ${item?.enabled !== false ? 'selected' : ''}>Включено</option><option value="false" ${item?.enabled === false ? 'selected' : ''}>На паузе</option></select>`)}
    </div>${formFooter(item ? 'Сохранить' : 'Добавить занятие')}</form>`);
}

document.addEventListener('click', async event => {
  const navigation = event.target.closest('[data-view]');
  if (navigation && state) { setView(navigation.dataset.view, true); return; }
  if (event.target.closest('[data-close-dialog]')) { closeDialog(); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { queueFilter = filter.dataset.filter; render(); return; }
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || !state) return;
  const { action, id } = target.dataset, queue = queueById(id);
  if (action === 'goto-queues') return setView('queues', true);
  if (action === 'goto-schedule') return setView('schedule', true);
  if (action === 'open-queue') return openQueue(id);
  if (action === 'close-dialog') return closeDialog();
  if (action === 'confirm') return confirmCallback?.();
  if (action === 'refresh') {
    target.disabled = true;
    try { applyState(await api.state()); toast('Очереди обновлены.'); } catch (error) { toast(errorText(error), true); }
    finally { target.disabled = false; } return;
  }
  if (action === 'join') return mutate('join', { queue_id: id }, 'Вы записались в очередь.');
  if (action === 'leave') return mutate('leave', { queue_id: id }, 'Вы вышли из очереди.');
  if (action === 'next' && queue) return mutate('next', { queue_id: id, expected_revision: Number(target.dataset.revision) }, 'Следующий участник вызван.');
  if (!isAdmin()) return;
  if (action === 'create-subject') return openSubjectForm();
  if (action === 'create-queue') return openQueueForm(id);
  if (action === 'create-schedule') return openScheduleForm();
  if (action === 'edit-schedule') return openScheduleForm(id);
  if (action === 'delete-subject') {
    const subject = state.subjects.find(item => item.id === id); if (!subject) return;
    return confirmAction(`Удалить ${subject.name}?`, 'Предмет, его очереди, записи участников и расписание будут удалены. Другие предметы сохранятся.', 'Удалить предмет', 'delete_subject', { subject_id: id });
  }
  if (action === 'delete-schedule') {
    const item = state.schedules.find(schedule => schedule.id === id); if (!item) return;
    return confirmAction('Удалить занятие из расписания?', `${item.subject_name}: новые очереди больше не будут создаваться. Будущие пустые очереди, в которые ещё не открывалась запись, будут удалены. Очереди с участниками сохранятся.`, 'Удалить занятие', 'delete_schedule', { schedule_id: id });
  }
  if (action === 'remove-entry' && queue) {
    const entry = queue.entries.find(item => item.id === target.dataset.entryId); if (!entry) return;
    return confirmAction('Убрать участника?', `${fullName(entry)} будет убран из очереди «${queue.subject_name}». Он сможет записаться в конец заново.`, 'Убрать из очереди', 'remove_entry', { queue_id: id, entry_id: entry.id }, () => openQueue(id));
  }
  if (action === 'close-queue' && queue) return confirmAction('Закрыть очередь?', `Запись на «${queue.subject_name}» будет завершена. Список участников сохранится.`, 'Закрыть очередь', 'close_queue', { queue_id: id }, () => openQueue(id));
  if (action === 'archive-queue' && queue) return confirmAction('Убрать очередь в архив?', `Очередь «${queue.subject_name}» исчезнет из активного списка. Предмет и расписание сохранятся.`, 'В архив', 'archive_queue', { queue_id: id });
});
document.addEventListener('input', event => {
  if (event.target.id !== 'queue-search') return;
  queueSearch = event.target.value; $('#queue-results').innerHTML = renderQueueResults(); updateCooldown();
});
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]'); if (!form || !state) return;
  event.preventDefault(); if (!isAdmin() || !form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form));
  try {
    if (form.dataset.form === 'subject') return void mutate('create_subject', { name: fields.name.trim() }, 'Предмет добавлен.', closeDialog);
    if (form.dataset.form === 'queue') {
      const starts = zonedToISO(fields.starts_at, tz()), opens = zonedToISO(fields.opens_at, tz());
      const minutes = Number(fields.duration_minutes);
      if (Date.parse(opens) > Date.parse(starts)) throw new Error('Открытие записи должно быть до начала занятия.');
      return void mutate('create_queue', { subject_id: fields.subject_id, title: fields.title.trim(), starts_at: starts, opens_at: opens,
        closes_at: new Date(Date.parse(starts) + minutes * 60_000).toISOString() }, 'Очередь создана.', () => { closeDialog(); setView('queues'); });
    }
    if (form.dataset.form === 'schedule') return void mutate('save_schedule', { ...(form.dataset.id ? { id: form.dataset.id } : {}),
      subject_id: fields.subject_id, weekday: Number(fields.weekday), local_time: fields.local_time,
      opens_minutes_before: Number(fields.opens_minutes_before), duration_minutes: Number(fields.duration_minutes), enabled: fields.enabled === 'true' }, 'Расписание сохранено.', closeDialog);
  } catch (error) { toast(errorText(error), true); }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = $('#auth-submit'); submit.disabled = true; $('#auth-status').textContent = 'Проверяем данные…';
  try {
    const fields = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(fields)) fields[key] = fields[key].trim();
    const fresh = await live.login(fields); form.elements.student_code.value = '';
    await enter(live, fresh); $('#auth-status').textContent = '';
  } catch (error) { $('#auth-status').textContent = errorText(error); }
  finally { submit.disabled = false; }
});
$('#demo-login').addEventListener('click', async () => {
  const demo = createDemoApi(); await enter(demo, await demo.login());
});
$('#signout').addEventListener('click', signOut);
dialog.addEventListener('click', event => { if (event.target === dialog) {
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
} });
dialog.addEventListener('close', () => { if (!dialog.open) { dialogState = null; confirmCallback = null; } });
window.addEventListener('hashchange', () => { if (state) setView(location.hash.replace('#/', '')); });
setInterval(updateCooldown, 500);

async function start() {
  $('#auth-demo-note').hidden = live.isConfigured;
  const demo = createDemoApi();
  const demoState = await demo.restore();
  if (demoState) { await enter(demo, demoState); return; }
  demo.destroy();
  if (!live.isConfigured) return;
  $('#auth-status').textContent = 'Проверяем сессию…';
  try {
    const restored = await live.restore();
    if (restored) await enter(live, restored);
    $('#auth-status').textContent = '';
  } catch (error) { $('#auth-status').textContent = errorText(error); }
}
start().catch(error => { $('#auth-status').textContent = errorText(error); });
