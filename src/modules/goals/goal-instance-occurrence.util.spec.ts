import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  assertTimelineInstanceForGoal,
  parseTimelineInstanceId,
  timelineStartTimeForGoalOnDate,
} from './goal-instance-occurrence.util';
import type { GoalReminderView } from './goal-reminder.view';

function baseGoal(overrides: Partial<GoalReminderView> = {}): GoalReminderView {
  return {
    id: 'goal-1',
    userId: 'user-1',
    title: 'Água',
    description: null,
    goalKind: 'Continua',
    conquestType: 'Corpo',
    icon: 'droplet',
    accentColor: 'green',
    completed: false,
    createdAt: '2026-01-01T12:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    schedule: { type: 'daily', times: ['08:00', '18:00'] },
    reminder: {
      dailyStatus: null,
      lastSentAt: null,
      slotsToday: [],
      silenceUntil: null,
      sentCount: 0,
      updatedAt: null,
    },
    user: null,
    plantedTree: { growthEvents: [] },
    ...overrides,
  };
}

describe('goal-instance-occurrence.util', () => {
  const tz = 'America/Sao_Paulo';

  it('parseTimelineInstanceId rejeita UUID legado', () => {
    expect(() =>
      parseTimelineInstanceId('70df550e-9b35-4e4f-8de4-cdf1692d698b'),
    ).toThrow(BadRequestException);
  });

  it('parseTimelineInstanceId aceita formato completo', () => {
    expect(parseTimelineInstanceId('goal-1:2026-10-15:08:00')).toEqual({
      goalId: 'goal-1',
      date: '2026-10-15',
      startTime: '08:00',
    });
  });

  it('timelineStartTimeForGoalOnDate usa o primeiro horário', () => {
    const goal = baseGoal();
    const day = DateTime.fromISO('2026-10-15', { zone: tz });
    expect(timelineStartTimeForGoalOnDate(goal, day, tz)).toBe('08:00');
  });

  it('assertTimelineInstanceForGoal rejeita horário diferente do primeiro slot', () => {
    const goal = baseGoal();
    const now = DateTime.fromISO('2026-10-15T12:00:00', { zone: tz });
    expect(() =>
      assertTimelineInstanceForGoal(
        goal,
        '2026-10-15',
        '18:00',
        tz,
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it('assertTimelineInstanceForGoal rejeita data futura', () => {
    const goal = baseGoal();
    const now = DateTime.fromISO('2026-10-14T12:00:00', { zone: tz });
    expect(() =>
      assertTimelineInstanceForGoal(
        goal,
        '2026-10-15',
        '08:00',
        tz,
        now,
      ),
    ).toThrow(BadRequestException);
  });

  it('assertTimelineInstanceForGoal aceita primeiro slot no passado', () => {
    const goal = baseGoal();
    const now = DateTime.fromISO('2026-10-16T12:00:00', { zone: tz });
    const day = assertTimelineInstanceForGoal(
      goal,
      '2026-10-15',
      '08:00',
      tz,
      now,
    );
    expect(day.toISODate()).toBe('2026-10-15');
  });
});
