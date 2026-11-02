import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimetable, filterLessons, lessonTimes, weekdayInZone } from '../src/timetable.js';

const lesson = (id, weekday, local_time, duration_minutes, subject_name = 'Common') =>
  ({ id, weekday, local_time, duration_minutes, subject_name, enabled: true });

test('ML and CGF filters preserve common lessons and never change source data', () => {
  const source = [lesson('a',1,'16:00',110,'RMT'),lesson('b',3,'16:00',50,'ML'),lesson('c',3,'17:00',60,'CGF')];
  const snapshot = JSON.stringify(source);
  assert.deepEqual(filterLessons(source,'ml').map(item => item.id),['a','b']);
  assert.deepEqual(filterLessons(source,'cgf').map(item => item.id),['a','c']);
  assert.equal(filterLessons(source,'all').length,3);
  buildTimetable(source,'all',1);
  assert.equal(JSON.stringify(source),snapshot);
});

test('actual 50 and 110 minute blocks retain exact ending times', () => {
  assert.equal(lessonTimes(lesson('a',1,'16:00',110)).label,'16:00–17:50');
  assert.equal(lessonTimes(lesson('b',5,'18:00',50)).label,'18:00–18:50');
  assert.equal(lessonTimes(lesson('c',6,'23:00',120)).label,'23:00–01:00 (+1 день)');
  assert.equal(lessonTimes(lesson('d',1,'25:00',60)),null);
});

test('a full week uses a common time axis and bounds all lesson rectangles', () => {
  const model = buildTimetable([lesson('a',1,'16:00',110),lesson('b',2,'14:00',110),lesson('c',6,'18:00',110)]);
  assert.equal(model.startHour,14); assert.equal(model.endHour,20);
  assert.equal(model.count,3); assert.equal(model.days.length,6);
  for (const item of model.days.flatMap(day => day.lessons)) {
    assert.ok(item.top >= 0); assert.ok(item.height > 0); assert.ok(item.top + item.height <= 100.000001);
  }
});

test('overlapping intervals use separate lanes, including transitive overlaps', () => {
  const model = buildTimetable([
    lesson('first',2,'14:00',100), lesson('second',2,'15:00',100),
    lesson('third',2,'16:00',50), lesson('later',2,'18:00',50),
  ]);
  const entries = model.days[1].lessons;
  for (let i=0;i<entries.length;i++) for(let j=i+1;j<entries.length;j++) {
    if (entries[i].start < entries[j].finish && entries[j].start < entries[i].finish) {
      assert.notEqual(entries[i].lane,entries[j].lane);
    }
  }
  assert.equal(entries[0].lanes,2); assert.equal(entries[2].lanes,2);
  assert.equal(entries[3].lanes,1);
});

test('touching classes reuse a lane and paused schedules remain editable', () => {
  const source = [lesson('a',1,'14:00',60),{...lesson('b',1,'15:00',60),enabled:false}];
  const model = buildTimetable(source);
  assert.ok(model.days[0].lessons.every(item => item.lane===0 && item.lanes===1));
  assert.equal(model.count,2); assert.equal(model.activeCount,1);
});

test('today uses the group timezone and Sunday stays available when needed', () => {
  assert.equal(weekdayInZone('2026-11-02T20:30:00Z','Asia/Qyzylorda'),2);
  assert.equal(buildTimetable([], 'all',7).days.length,7);
  const model = buildTimetable([lesson('sunday',7,'12:00',50)],'all',1);
  assert.equal(model.days.length,7); assert.equal(model.days[6].lessons.length,1);
});
