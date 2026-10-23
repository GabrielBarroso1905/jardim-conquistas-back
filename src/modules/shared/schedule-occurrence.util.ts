import { DateTime } from 'luxon';
import type { ScheduleConfig } from '../../domain/types/schedule-config.type';
import {
  luxonWeekdayToJsDayOfWeek,
  normalizeDaysOfWeekJson,
} from './weekday.util';
import { parseInstantInTimezone } from './parse-instant-timezone.util';

export type GoalLike = {
  id?: string;
  createdAt: Date | string;
  schedule?: ScheduleConfig | null;
  scheduleConfig?: ScheduleConfig | null | unknown;
};

function rawSchedule(goal: GoalLike): unknown {
  return goal.schedule ?? goal.scheduleConfig;
}

/** `day` é o mesmo dia civil ou posterior ao dia em que a meta foi criada (fuso `tz`). */
export function isOnOrAfterGoalCreationDay(
  day: DateTime,
  createdAt: Date | string,
  tz: string,
): boolean {
  const dayStart = day.setZone(tz).startOf('day');
  const createdDay = DateTime.fromJSDate(new Date(createdAt))
    .setZone(tz)
    .startOf('day');
  return dayStart >= createdDay;
}

/**
 * Quantidade de "slots" esperados para a meta em um dia civil no fuso `tz`
 * (ex.: weekly ter/qui com 1 horário → 1; daily com 2 horários → 2).
 */
export function expectedSlotCountForGoalOnDate(
  goal: GoalLike,
  day: DateTime,
  tz: string,
): number {
  const raw = rawSchedule(goal);
  if (!raw || typeof raw !== 'object') return 0;
  const sc = raw as ScheduleConfig;
  if (!isOnOrAfterGoalCreationDay(day, goal.createdAt, tz)) return 0;
  const dayStart = day.setZone(tz).startOf('day');

  if (sc.type === 'once') {
    const userAt = parseInstantInTimezone(sc.at, tz);
    if (!userAt?.isValid) return 0;
    return userAt.setZone(tz).hasSame(dayStart, 'day') ? 1 : 0;
  }

  if (sc.type === 'daily') {
    if (sc.durationDays) {
      const createdAt = DateTime.fromJSDate(new Date(goal.createdAt)).setZone(
        tz,
      );
      const daysSince = Math.floor(dayStart.diff(createdAt, 'days').days);
      if (daysSince >= sc.durationDays) return 0;
    }
    return Array.isArray(sc.times) && sc.times.length > 0 ? sc.times.length : 0;
  }

  if (sc.type === 'weekly') {
    const dow = luxonWeekdayToJsDayOfWeek(day.setZone(tz).weekday);
    if (!normalizeDaysOfWeekJson(sc.daysOfWeek).includes(dow)) return 0;
    return Array.isArray(sc.times) && sc.times.length > 0 ? sc.times.length : 0;
  }

  if (sc.type === 'monthly') {
    const dom =
      typeof sc.dayOfMonth === 'number' ? Math.trunc(sc.dayOfMonth) : NaN;
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) return 0;
    if (dayStart.day !== dom) return 0;
    return Array.isArray(sc.times) && sc.times.length > 0 ? sc.times.length : 0;
  }

  return 0;
}

function padHHmm(hh: number, mm: number): string | null {
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Normaliza "8:00" / "08:00:00" / "10h" / "10h00" / ISO para "HH:mm". */
export function normalizeTimeToHHmm(
  value: string,
  timezone?: string,
): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const colon = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colon) return padHHmm(parseInt(colon[1], 10), parseInt(colon[2], 10));

  const dotted = trimmed.match(/^(\d{1,2})\.(\d{2})$/);
  if (dotted) return padHHmm(parseInt(dotted[1], 10), parseInt(dotted[2], 10));

  const h = trimmed.match(/^(\d{1,2})\s*h(?:\s*(\d{2}))?$/i);
  if (h) return padHHmm(parseInt(h[1], 10), parseInt(h[2] || '0', 10));

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) || trimmed.includes('T')) {
    if (timezone) {
      const dt = parseInstantInTimezone(trimmed, timezone);
      if (dt?.isValid) return dt.setZone(timezone).toFormat('HH:mm');
    }
    const iso = DateTime.fromISO(trimmed, { setZone: true });
    if (iso.isValid) return iso.toFormat('HH:mm');
  }

  return null;
}

export function coerceTimesList(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw
    : raw == null || raw === ''
      ? []
      : [raw];
  const out: string[] = [];
  for (const item of items) {
    const t = normalizeTimeToHHmm(String(item));
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Aceita o JSON frouxo do LLM/front (type DAILY, times string, horário em `at`)
 * e devolve ScheduleConfig canônico — ou undefined se não der para gravar.
 */
export function coerceScheduleConfig(
  raw: unknown,
  opts?: {
    reminderTime?: Date | string | null;
    timeToken?: string | null;
    goalType?: string | null;
  },
): ScheduleConfig | undefined {
  const reminderRaw =
    opts?.reminderTime instanceof Date
      ? DateTime.fromJSDate(opts.reminderTime).toISO()
      : opts?.reminderTime != null
        ? String(opts.reminderTime).trim()
        : '';
  const tokenRaw = opts?.timeToken != null ? String(opts.timeToken).trim() : '';
  const fallbackTimes = coerceTimesList(
    [reminderRaw, tokenRaw].filter(Boolean),
  );

  const o =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const type = (
    (o && typeof o.type === 'string' && o.type) ||
    (o && typeof o.frequency === 'string' && o.frequency) ||
    ''
  )
    .trim()
    .toLowerCase();
  const durationDays =
    o &&
    typeof o.durationDays === 'number' &&
    Number.isInteger(o.durationDays) &&
    o.durationDays >= 1
      ? o.durationDays
      : undefined;

  const timesFromAt = (): string[] => {
    if (!o?.at) return [];
    const at = String(o.at).trim();
    const asTime = normalizeTimeToHHmm(at);
    if (asTime) return [asTime];
    const iso = DateTime.fromISO(at);
    return iso.isValid ? [iso.toFormat('HH:mm')] : [];
  };

  if (type === 'once') {
    const at = (typeof o?.at === 'string' && o.at.trim()) || reminderRaw;
    if (at) return { type: 'once', at };
    return undefined;
  }

  if (type === 'daily' || type === 'day') {
    let times = coerceTimesList(o?.times);
    if (times.length === 0) times = timesFromAt();
    if (times.length === 0) times = fallbackTimes;
    if (times.length === 0) return undefined;
    return durationDays
      ? { type: 'daily', times, durationDays }
      : { type: 'daily', times };
  }

  if (type === 'weekly') {
    const days = Array.isArray(o?.daysOfWeek)
      ? o.daysOfWeek
          .map((d) => (typeof d === 'number' ? d : parseInt(String(d), 10)))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    let times = coerceTimesList(o?.times);
    if (times.length === 0) times = timesFromAt();
    if (times.length === 0) times = fallbackTimes;
    if (days.length === 0 || times.length === 0) return undefined;
    return { type: 'weekly', daysOfWeek: days, times };
  }

  if (type === 'monthly') {
    const rawDom = o?.dayOfMonth;
    const dom =
      typeof rawDom === 'number'
        ? Math.trunc(rawDom)
        : parseInt(String(rawDom ?? ''), 10);
    let times = coerceTimesList(o?.times);
    if (times.length === 0) times = timesFromAt();
    if (times.length === 0) times = fallbackTimes;
    if (!Number.isFinite(dom) || dom < 1 || dom > 31 || times.length === 0)
      return undefined;
    return { type: 'monthly', dayOfMonth: dom, times };
  }

  const inferredTimes = coerceTimesList(o?.times);
  const times =
    inferredTimes.length > 0
      ? inferredTimes
      : timesFromAt().length > 0
        ? timesFromAt()
        : fallbackTimes;
  if (times.length === 0) return undefined;

  const goalKind = String(opts?.goalType || '').toLowerCase();
  const isPontual = goalKind === 'pontual';
  if (isPontual) {
    return { type: 'once', at: reminderRaw || `${times[0]}` };
  }
  return durationDays
    ? { type: 'daily', times, durationDays }
    : { type: 'daily', times };
}

/**
 * Horários agendados (HH:mm) para a meta em um dia civil no fuso `tz`.
 * Retorna [] quando a meta não tem ocorrência naquele dia.
 */
export function scheduledTimesForGoalOnDate(
  goal: GoalLike,
  day: DateTime,
  tz: string,
): string[] {
  if (expectedSlotCountForGoalOnDate(goal, day, tz) === 0) return [];

  const sc = rawSchedule(goal) as ScheduleConfig | null | undefined;
  if (!sc || typeof sc !== 'object') return [];

  if (sc.type === 'once') {
    const userAt = parseInstantInTimezone(sc.at, tz);
    if (!userAt?.isValid) return [];
    return [userAt.setZone(tz).toFormat('HH:mm')];
  }

  if (Array.isArray(sc.times) && sc.times.length > 0) {
    return sc.times
      .map((t) => normalizeTimeToHHmm(String(t)))
      .filter((t): t is string => t != null);
  }

  return [];
}

export type SlotOccurrence = {
  civilDate: string;
  hhmm: string;
  at: DateTime;
};

/** Ocorrências agendadas no dia civil `day` no fuso `tz`. Sem I/O. */
export function occurrencesOnCivilDate(
  goal: GoalLike,
  day: DateTime,
  tz: string,
): SlotOccurrence[] {
  const zone = day.setZone(tz);
  const civilDate = zone.toISODate() || '';
  return scheduledTimesForGoalOnDate(goal, day, tz).map((hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    const at = zone.set({
      hour: hh || 0,
      minute: mm || 0,
      second: 0,
      millisecond: 0,
    });
    return { civilDate, hhmm, at };
  });
}

export function hasOccurrenceOnCivilDate(
  goal: GoalLike,
  day: DateTime,
  tz: string,
): boolean {
  return occurrencesOnCivilDate(goal, day, tz).length > 0;
}

export function filterGoalsOnCivilDate<T extends GoalLike>(
  goals: T[],
  day: DateTime,
  tz: string,
): T[] {
  return goals.filter((g) => hasOccurrenceOnCivilDate(g, day, tz));
}

/** Catch-up aberto: due quando o instante local já passou. */
export function isOccurrenceDue(occ: SlotOccurrence, now: DateTime): boolean {
  return now.toUTC() >= occ.at.toUTC();
}

type GrowthEventLike = {
  id?: string;
  createdAt: Date | string;
  progressIndex?: number;
};

type GoalDailyStatusLike = {
  dailyStatus?: string | null;
  reminderUpdatedAt?: Date | string | null;
  reminder?: {
    updatedAt?: Date | string | null;
    dailyStatus?: string | null;
  } | null;
  plantedTree?: {
    growthEvents?: GrowthEventLike[];
  } | null;
};

/** Mesmo dia civil no fuso `tz`. */
export function isSameCalendarDay(
  a: DateTime,
  b: DateTime,
  tz: string,
): boolean {
  return a
    .setZone(tz)
    .startOf('day')
    .hasSame(b.setZone(tz).startOf('day'), 'day');
}

/** Há colheita/conclusão no dia civil (ignora o plantio inicial progressIndex=1). */
export function hasCompletionOnCalendarDay(
  goal: GoalDailyStatusLike,
  targetDate: DateTime,
  tz: string,
): boolean {
  const events = goal.plantedTree?.growthEvents ?? [];
  if (events.length === 0) return false;

  const sorted = [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const initialEvent = sorted[0]?.progressIndex === 1 ? sorted[0] : null;
  const dayStart = targetDate.setZone(tz).startOf('day');
  const dayEnd = targetDate.setZone(tz).endOf('day');

  return sorted.some((ev) => {
    if (initialEvent && ev === initialEvent) return false;
    const at = DateTime.fromJSDate(new Date(ev.createdAt)).setZone(tz);
    return at >= dayStart && at <= dayEnd;
  });
}

function reminderTouchedOnDay(
  goal: GoalDailyStatusLike,
  day: DateTime,
  tz: string,
): boolean {
  const raw = goal.reminderUpdatedAt ?? goal.reminder?.updatedAt ?? null;
  if (!raw) return false;
  const at = DateTime.fromJSDate(new Date(raw)).setZone(tz);
  return at.isValid && isSameCalendarDay(at, day, tz);
}

export type OccurrenceStatus = 'PENDING' | 'DONE' | 'MISSED' | 'SKIPPED';

const OCCURRENCE_FALLBACK_TIME = '08:00';

/**
 * Status da linha da timeline (uma por meta por dia civil).
 * DONE e SKIPPED vêm de resolveDailyStatusForDate. MISSED só quando
 * o último horário daquele dia já passou. Dia futuro permanece PENDING.
 */
export function resolveOccurrenceStatus(
  goal: GoalLike & GoalDailyStatusLike,
  targetDate: DateTime,
  tz: string,
  now: DateTime = DateTime.now(),
): OccurrenceStatus {
  const daily = resolveDailyStatusForDate(goal, targetDate, tz, now);
  if (daily === 'DONE') return 'DONE';

  const targetDay = targetDate.setZone(tz).startOf('day');
  const today = now.setZone(tz).startOf('day');

  if (targetDay.hasSame(today, 'day') && daily === 'SKIPPED') return 'SKIPPED';
  if (targetDay > today) return 'PENDING';

  const slots = occurrencesOnCivilDate(goal, targetDate, tz);
  const deadline =
    slots.length > 0
      ? slots.reduce(
          (latest, slot) =>
            slot.at.toMillis() > latest.toMillis() ? slot.at : latest,
          slots[0].at,
        )
      : slotAt(targetDay, OCCURRENCE_FALLBACK_TIME);

  if (now.toMillis() >= deadline.toMillis()) return 'MISSED';
  return 'PENDING';
}

function slotAt(dayStart: DateTime, hhmm: string): DateTime {
  const [hour, minute] = hhmm.split(':').map(Number);
  return dayStart.set({
    hour: hour || 0,
    minute: minute || 0,
    second: 0,
    millisecond: 0,
  });
}

/**
 * dailyStatus contextual à data consultada (não é o valor bruto do GoalReminder).
 * CONTINUA + DAILY: conclusão é por dia civil. DONE de ontem não pinta amanhã.
 */
export function resolveDailyStatusForDate(
  goal: GoalDailyStatusLike,
  targetDate: DateTime,
  tz: string,
  now: DateTime = DateTime.now(),
): string | null {
  if (hasCompletionOnCalendarDay(goal, targetDate, tz)) return 'DONE';

  const targetDay = targetDate.setZone(tz).startOf('day');
  const today = now.setZone(tz).startOf('day');

  if (targetDay.hasSame(today, 'day')) {
    const live = goal.dailyStatus ?? goal.reminder?.dailyStatus ?? null;
    if (live === 'DONE') {
      return reminderTouchedOnDay(goal, today, tz) ? 'DONE' : 'PENDING';
    }
    return live ?? 'PENDING';
  }

  return 'PENDING';
}

/**
 * Semana que contém `anchor`: segunda 00:00 até domingo 23:59:59 no fuso `tz`.
 * `nextMonday` (exclusivo) facilita queries `createdAt < nextMonday`.
 */
export function weekRangeContainingDate(
  anchor: DateTime,
  tz: string,
): { monday: DateTime; sundayEnd: DateTime; nextMonday: DateTime } {
  const monday = anchor.setZone(tz).set({ weekday: 1 }).startOf('day');
  const nextMonday = monday.plus({ weeks: 1 });
  const sundayEnd = monday.plus({ days: 6 }).endOf('day');
  return { monday, sundayEnd, nextMonday };
}

/**
 * Interpreta `date` ou `YYYY-MM` no fuso `tz` e devolve o intervalo do mês civil
 * (início do 1º dia → exclusivo do 1º dia do mês seguinte, para queries UTC).
 */
export function monthRangeFromInput(
  input: string,
  tz: string,
): {
  monthStart: DateTime;
  monthEnd: DateTime;
  nextMonthStart: DateTime;
  yearMonth: string;
} | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let anchor: DateTime;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    anchor = DateTime.fromISO(raw.slice(0, 10), { zone: tz });
  } else if (/^\d{4}-\d{2}$/.test(raw.slice(0, 7))) {
    anchor = DateTime.fromISO(`${raw.slice(0, 7)}-01`, { zone: tz });
  } else {
    return null;
  }

  if (!anchor.isValid) return null;

  const monthStart = anchor.startOf('month');
  const monthEnd = anchor.endOf('month');
  const nextMonthStart = monthStart.plus({ months: 1 });
  const yearMonth = monthStart.toFormat('yyyy-LL');

  return { monthStart, monthEnd, nextMonthStart, yearMonth };
}
