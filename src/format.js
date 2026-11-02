export const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const WEEKDAYS_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
export function fullName(person = {}) {
  return person.display_name || [person.first_name, person.last_name].filter(Boolean).join(' ') || 'Участник';
}
export function initials(person = {}) {
  return fullName(person).split(/\s+/).slice(0, 2).map(part => [...part][0]).join('').toUpperCase();
}
export function formatTime(value, timezone = 'Asia/Qyzylorda') {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(value));
}
export function formatDate(value, timezone = 'Asia/Qyzylorda', weekday = false) {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', ...(weekday ? { weekday: 'short' } : {}), timeZone: timezone }).format(new Date(value));
}
export function localDateTime(value, timezone = 'Asia/Qyzylorda') {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function zonedToISO(value, timezone = 'Asia/Qyzylorda') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Укажи дату и время занятия.');
  const target = Date.parse(value + ':00Z');
  if (!Number.isFinite(target)) throw new Error('Проверь дату и время занятия.');
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const rendered = Date.parse(localDateTime(instant, timezone) + ':00Z');
    instant += target - rendered;
  }
  if (localDateTime(instant, timezone) !== value) throw new Error('Это время недоступно в выбранном часовом поясе.');
  return new Date(instant).toISOString();
}
export function activeQueues(state) {
  return (state?.queues || []).filter(queue => queue.status !== 'archived')
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
}
export function myQueues(state) {
  return activeQueues(state).filter(queue => queue.status !== 'closed' && Boolean(queue.my_entry_id));
}
export function ordinalPeople(count) {
  const value = Math.abs(count) % 100;
  const suffix = value % 10;
  return `${count} ${value >= 11 && value <= 14 ? 'человек' : suffix === 1 ? 'человек' : suffix >= 2 && suffix <= 4 ? 'человека' : 'человек'}`;
}
