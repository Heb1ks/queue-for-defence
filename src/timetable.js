import { localDateTime, WEEKDAYS, WEEKDAYS_SHORT } from './format.js';

export function weekdayInZone(now = Date.now(), timezone = 'Asia/Qyzylorda') {
  const localDay = localDateTime(now, timezone).slice(0, 10);
  return new Date(`${localDay}T12:00:00Z`).getUTCDay() || 7;
}

export function lessonTimes(lesson) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(lesson.local_time || ''));
  const duration = Number(lesson.duration_minutes);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || !Number.isFinite(duration) || duration <= 0) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const finish = start + duration;
  const end = finish % 1440;
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  return { start, finish, endTime, nextDay: finish >= 1440,
    label: `${lesson.local_time}–${endTime}${finish >= 1440 ? ' (+1 день)' : ''}` };
}

export function lessonCategory(name = '') {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'ml') return 'ml';
  if (normalized === 'cgf') return 'cgf';
  if (normalized.includes('cloud')) return 'cloud';
  if (normalized.includes('network')) return 'networks';
  if (normalized === 'rmt') return 'rmt';
  if (normalized.includes('philosophy')) return 'philosophy';
  if (normalized.includes('project')) return 'projects';
  return 'default';
}

export function filterLessons(lessons, track = 'all') {
  return lessons.filter(lesson => {
    const category = lessonCategory(lesson.subject_name);
    return track === 'ml' ? category !== 'cgf' : track === 'cgf' ? category !== 'ml' : true;
  });
}

function placeOverlapping(lessons) {
  const result = [];
  let cluster = [], clusterEnd = -1;
  const finishCluster = () => {
    const laneEnds = [];
    for (const lesson of cluster) {
      let lane = laneEnds.findIndex(end => end <= lesson.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = lesson.finish;
      lesson.lane = lane;
    }
    for (const lesson of cluster) result.push({ ...lesson, lanes: laneEnds.length });
    cluster = [];
  };
  for (const lesson of lessons) {
    if (cluster.length && lesson.start >= clusterEnd) finishCluster();
    if (!cluster.length) clusterEnd = lesson.finish;
    else clusterEnd = Math.max(clusterEnd, lesson.finish);
    cluster.push({ ...lesson });
  }
  if (cluster.length) finishCluster();
  return result;
}

export function buildTimetable(lessons = [], track = 'all', today = 1) {
  const visible = filterLessons(lessons, track).map(lesson => {
    const timing = lessonTimes(lesson);
    return timing && Number.isInteger(Number(lesson.weekday)) && lesson.weekday >= 1 && lesson.weekday <= 7
      ? { ...lesson, ...timing, category: lessonCategory(lesson.subject_name) } : null;
  }).filter(Boolean).sort((a, b) => a.weekday - b.weekday || a.start - b.start || String(a.id).localeCompare(String(b.id)));
  const startHour = visible.length ? Math.max(0, Math.floor(Math.min(...visible.map(lesson => lesson.start)) / 60)) : 9;
  const endHour = visible.length ? Math.min(24, Math.max(startHour + 1, Math.ceil(Math.max(...visible.map(lesson => lesson.finish)) / 60))) : 18;
  const dayCount = visible.some(lesson => Number(lesson.weekday) === 7) || today === 7 ? 7 : 6;
  const span = (endHour - startHour) * 60;
  const days = Array.from({ length: dayCount }, (_, index) => {
    const number = index + 1;
    const items = placeOverlapping(visible.filter(lesson => Number(lesson.weekday) === number));
    return { number, name: WEEKDAYS[index], short: WEEKDAYS_SHORT[index], today: number === today,
      lessons: items.map(lesson => ({ ...lesson,
        top: ((lesson.start - startHour * 60) / span) * 100,
        height: ((Math.min(lesson.finish, endHour * 60) - lesson.start) / span) * 100,
      })) };
  });
  return { days, startHour, endHour, hours: endHour - startHour, count: visible.length,
    activeCount: visible.filter(lesson => lesson.enabled !== false).length,
    ticks: Array.from({ length: endHour - startHour + 1 }, (_, index) => `${String(startHour + index).padStart(2, '0')}:00`) };
}
