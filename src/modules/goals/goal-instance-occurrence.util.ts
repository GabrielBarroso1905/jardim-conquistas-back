import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { parseGoalInstanceId } from './goal-instance-id';
import type { GoalReminderView } from './goal-reminder.view';
import {
  hasCompletionOnCalendarDay,
  hasOccurrenceOnCivilDate,
  normalizeTimeToHHmm,
  scheduledTimesForGoalOnDate,
  type GoalLike,
} from '../shared/schedule-occurrence.util';

const TIMELINE_FALLBACK_START = '08:00';

export type ParsedTimelineInstance = {
  goalId: string;
  date: string;
  startTime: string;
};

export function timelineStartTimeForGoalOnDate(
  goal: GoalLike,
  day: DateTime,
  tz: string,
): string {
  const times = scheduledTimesForGoalOnDate(goal, day, tz);
  return times[0] || TIMELINE_FALLBACK_START;
}

export function parseTimelineInstanceId(raw: string): ParsedTimelineInstance {
  const parsed = parseGoalInstanceId(raw);
  if (!parsed?.date || !parsed?.startTime) {
    throw new BadRequestException(
      'instanceId inválido. Use {goalId}:{YYYY-MM-DD}:{HH:mm}.',
    );
  }

  const day = DateTime.fromISO(parsed.date, { zone: 'utc' });
  if (!day.isValid) {
    throw new BadRequestException('Data da ocorrência inválida.');
  }

  const startTime = normalizeTimeToHHmm(parsed.startTime);
  if (!startTime) {
    throw new BadRequestException('Horário da ocorrência inválido.');
  }

  return {
    goalId: parsed.goalId,
    date: parsed.date,
    startTime,
  };
}

export function resolveCivilDayForInstance(
  dateIso: string,
  tz: string,
): DateTime {
  const day = DateTime.fromISO(dateIso, { zone: tz }).startOf('day');
  if (!day.isValid) {
    throw new BadRequestException('Data da ocorrência inválida.');
  }
  return day;
}

/** Valida meta, dia civil e horário da linha da timeline (primeiro slot do dia). */
export function assertTimelineInstanceForGoal(
  goal: GoalReminderView,
  dateIso: string,
  startTime: string,
  tz: string,
  now: DateTime = DateTime.now(),
): DateTime {
  const day = resolveCivilDayForInstance(dateIso, tz);
  const goalLike: GoalLike = {
    id: goal.id,
    createdAt: goal.createdAt,
    schedule: goal.schedule,
  };

  if (!hasOccurrenceOnCivilDate(goalLike, day, tz)) {
    throw new BadRequestException('Meta sem ocorrência nesta data.');
  }

  const expectedStart = timelineStartTimeForGoalOnDate(goalLike, day, tz);
  if (startTime !== expectedStart) {
    throw new BadRequestException(
      'Horário não corresponde à ocorrência da timeline.',
    );
  }

  const today = now.setZone(tz).startOf('day');
  if (day > today) {
    throw new BadRequestException(
      'Não é possível alterar ocorrência em data futura.',
    );
  }

  return day;
}

export function isTimelineInstanceDone(
  goal: GoalReminderView,
  day: DateTime,
  tz: string,
): boolean {
  const withReminder = {
    ...goal,
    dailyStatus: goal.reminder.dailyStatus,
    reminderUpdatedAt: goal.reminder.updatedAt,
    reminder: goal.reminder,
  };
  return hasCompletionOnCalendarDay(withReminder, day, tz);
}
