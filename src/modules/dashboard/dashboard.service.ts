import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { prisma } from '../../prisma/client';
import { UserGoalService } from '../goals/user-goal.service';
import {
  expectedSlotCountForGoalOnDate,
  monthRangeFromInput,
  resolveOccurrenceStatus,
  scheduledTimesForGoalOnDate,
  weekRangeContainingDate,
  type OccurrenceStatus,
} from '../shared/schedule-occurrence.util';
import { visualForConquestType } from '../shared/area-visual.util';
import { buildGoalInstanceId } from '../goals/goal-instance-id';
import type { ScheduleConfig } from '../../domain/types/schedule-config.type';

const FALLBACK_START_TIME = '08:00';

function plusThirtyMinutes(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const base = DateTime.fromObject({ hour: h || 0, minute: m || 0 });
  return base.plus({ minutes: 30 }).toFormat('HH:mm');
}

function progressPercentage(harvested: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(
    100,
    Math.round((Math.min(harvested, total) / total) * 100),
  );
}

type TimelineOccurrence = {
  instanceId: string;
  goalId: string;
  title: string;
  goalKind: string;
  conquestType: string;
  schedule: ScheduleConfig | null;
  startTime: string;
  endTime: string;
  status: OccurrenceStatus;
  icon: string;
  accentColor: string;
};

function harvestSummaryFromOccurrences(
  occurrences: Pick<TimelineOccurrence, 'status'>[],
): { collected: number; total: number } {
  return {
    total: occurrences.length,
    collected: occurrences.filter((o) => o.status === 'DONE').length,
  };
}

function toTimelineOccurrence(
  goal: any,
  civilDate: DateTime,
  now: DateTime,
  tz: string,
): TimelineOccurrence {
  const resolvedDate = civilDate.toISODate() || '';
  const times = scheduledTimesForGoalOnDate(goal, civilDate, tz);
  const startTime = times[0] || FALLBACK_START_TIME;
  const status = resolveOccurrenceStatus(goal, civilDate, tz, now);
  const visual = visualForConquestType(goal.conquestType);
  const schedule = (goal.schedule ?? null) as ScheduleConfig | null;

  return {
    instanceId: buildGoalInstanceId(String(goal.id), resolvedDate, startTime),
    goalId: String(goal.id),
    title: String(goal.title),
    goalKind: String(goal.goalKind ?? ''),
    conquestType: String(goal.conquestType ?? ''),
    schedule,
    startTime,
    endTime: plusThirtyMinutes(startTime),
    status,
    icon: visual.icon,
    accentColor: visual.accentColor,
  };
}

@Injectable()
export class DashboardService {
  constructor(private readonly userGoalService: UserGoalService) {}

  async getDashboardDay(userId: string, date: string, areaId?: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz =
      user?.timezone && String(user.timezone).trim()
        ? user.timezone
        : 'America/Sao_Paulo';

    const datePart = String(date || '').slice(0, 10);
    const day = DateTime.fromISO(datePart, { zone: tz });
    const targetDate = day.isValid ? day : DateTime.now().setZone(tz);
    const now = DateTime.now().setZone(tz);

    let goals = await this.userGoalService.getGoalsForDateForUser(
      userId,
      targetDate,
      tz,
      {
        includeCompleted: true,
      },
    );
    if (areaId && String(areaId).trim()) {
      const a = String(areaId).trim();
      goals = goals.filter((g: any) => String(g.conquestType) === a);
    }

    const resolvedDate = targetDate.toISODate() || datePart;
    const occurrences = goals.map((g: any) =>
      toTimelineOccurrence(g, targetDate, now, tz),
    );

    return {
      date: resolvedDate,
      occurrences,
      harvestSummary: harvestSummaryFromOccurrences(occurrences),
    };
  }

  async getDashboardWeek(userId: string, date: string, areaId?: string) {
    const area =
      areaId && String(areaId).trim() ? String(areaId).trim() : undefined;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz =
      user?.timezone && String(user.timezone).trim()
        ? user.timezone
        : 'America/Sao_Paulo';

    const datePart = String(date || '').slice(0, 10);
    const anchor = DateTime.fromISO(datePart, { zone: tz });
    if (!anchor.isValid) {
      return {
        date: datePart || null,
        areaId: area ?? null,
        weekStart: null,
        weekEnd: null,
        weekGrid: [] as Array<{
          date: string | null;
          expectedSlots: number;
          harvestCount: number;
          occurrences: TimelineOccurrence[];
        }>,
        weeklyProgress: { percentage: 0, total: 0, harvested: 0 },
        harvestCount: 0,
        gardenLayers: [],
      };
    }

    const { monday, sundayEnd } = weekRangeContainingDate(
      anchor,
      tz,
    );
    const now = DateTime.now().setZone(tz);

    const goals = await this.userGoalService.getGoalsForUser(userId);
    const inScope = goals.filter((g: any) => {
      if (g.completed) return false;
      const st = g.status ?? 'ACTIVE';
      if (st !== 'ACTIVE') return false;
      if (area && String(g.conquestType) !== area) return false;
      return true;
    });

    let totalOccurrences = 0;
    let harvestedOccurrences = 0;
    const weekGrid: Array<{
      date: string | null;
      expectedSlots: number;
      harvestCount: number;
      occurrences: TimelineOccurrence[];
    }> = [];

    for (let i = 0; i < 7; i++) {
      const d = monday.plus({ days: i });
      const occurrences: TimelineOccurrence[] = [];
      let expectedSlots = 0;
      for (const g of inScope) {
        const n = expectedSlotCountForGoalOnDate(g, d, tz);
        if (n > 0) {
          expectedSlots += n;
          occurrences.push(toTimelineOccurrence(g, d, now, tz));
        }
      }
      const daySummary = harvestSummaryFromOccurrences(occurrences);
      totalOccurrences += daySummary.total;
      harvestedOccurrences += daySummary.collected;
      weekGrid.push({
        date: d.toISODate(),
        expectedSlots,
        harvestCount: daySummary.collected,
        occurrences,
      });
    }

    const harvestCount = harvestedOccurrences;
    const percentage = progressPercentage(harvestedOccurrences, totalOccurrences);

    const layerMap = new Map<string, number>();
    for (const g of inScope) {
      const k = String(g.conquestType || 'Outros');
      layerMap.set(k, (layerMap.get(k) || 0) + 1);
    }
    const gardenLayers = Array.from(layerMap.entries()).map(
      ([conquestType, goalCount]) => ({
        conquestType,
        goalCount,
      }),
    );

    return {
      date: datePart,
      areaId: area ?? null,
      weekStart: monday.toISODate(),
      weekEnd: sundayEnd.toISODate(),
      weekGrid,
      weeklyProgress: {
        percentage,
        total: totalOccurrences,
        harvested: harvestCount,
      },
      harvestCount,
      gardenLayers,
    };
  }

  async getDashboardMonth(
    userId: string,
    dateOrMonth: string,
    areaId?: string,
  ) {
    const area =
      areaId && String(areaId).trim() ? String(areaId).trim() : undefined;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz =
      user?.timezone && String(user.timezone).trim()
        ? user.timezone
        : 'America/Sao_Paulo';

    const parsed = monthRangeFromInput(dateOrMonth, tz);
    if (!parsed) {
      return {
        month: String(dateOrMonth || '').slice(0, 7) || null,
        areaId: area ?? null,
        monthStart: null,
        monthEnd: null,
        monthGrid: [],
        monthlyGoal: { percentage: 0, total: 0, harvested: 0 },
        activeDays: 0,
        monthHighlights: [],
      };
    }

    const { monthStart, monthEnd, nextMonthStart, yearMonth } = parsed;
    const daysInMonth = monthStart.daysInMonth ?? 31;
    const now = DateTime.now().setZone(tz);

    const goals = await this.userGoalService.getGoalsForUser(userId);
    const inScope = goals.filter((g: any) => {
      if (g.completed) return false;
      const st = g.status ?? 'ACTIVE';
      if (st !== 'ACTIVE') return false;
      if (area && String(g.conquestType) !== area) return false;
      return true;
    });

    type DayCell = {
      date: string | null;
      expectedSlots: number;
      harvestCount: number;
      occurrences: TimelineOccurrence[];
    };

    const monthGrid: DayCell[] = [];
    let totalOccurrences = 0;
    let harvestedOccurrences = 0;
    let activeDays = 0;

    for (let i = 0; i < daysInMonth; i++) {
      const d = monthStart.plus({ days: i });
      const occurrences: TimelineOccurrence[] = [];
      let expectedSlots = 0;
      for (const g of inScope) {
        const n = expectedSlotCountForGoalOnDate(g, d, tz);
        if (n > 0) {
          expectedSlots += n;
          occurrences.push(toTimelineOccurrence(g, d, now, tz));
        }
      }
      const daySummary = harvestSummaryFromOccurrences(occurrences);
      totalOccurrences += daySummary.total;
      harvestedOccurrences += daySummary.collected;
      if (daySummary.collected > 0) activeDays += 1;
      monthGrid.push({
        date: d.toISODate(),
        expectedSlots,
        harvestCount: daySummary.collected,
        occurrences,
      });
    }

    const growthEvents = await prisma.growthEvent.findMany({
      where: {
        createdAt: {
          gte: monthStart.toUTC().toJSDate(),
          lt: nextMonthStart.toUTC().toJSDate(),
        },
        plantedTree: {
          goal: {
            userId,
            ...(area ? { conquestType: area } : {}),
          },
        },
      },
      select: {
        createdAt: true,
        plantedTree: {
          select: {
            goal: { select: { id: true, title: true } },
          },
        },
      },
    });

    const harvestByGoal = new Map<string, { title: string; count: number }>();

    for (const ev of growthEvents) {
      const gid = ev.plantedTree?.goal?.id;
      const title = ev.plantedTree?.goal?.title;
      if (gid) {
        const prev = harvestByGoal.get(gid) || { title: title || '', count: 0 };
        prev.count += 1;
        if (title) prev.title = title;
        harvestByGoal.set(gid, prev);
      }
    }

    const harvestCount = harvestedOccurrences;
    const percentage = progressPercentage(harvestedOccurrences, totalOccurrences);

    const monthHighlights = Array.from(harvestByGoal.entries())
      .map(([goalId, { title, count }]) => ({
        goalId,
        title,
        harvestCount: count,
      }))
      .sort((a, b) => b.harvestCount - a.harvestCount)
      .slice(0, 5);

    return {
      month: yearMonth,
      areaId: area ?? null,
      monthStart: monthStart.toISODate(),
      monthEnd: monthEnd.toISODate(),
      monthGrid,
      monthlyGoal: {
        percentage,
        total: totalOccurrences,
        harvested: harvestCount,
      },
      activeDays,
      monthHighlights,
    };
  }
}
