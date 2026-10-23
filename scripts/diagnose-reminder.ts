/**
 * Diagnóstico: agenda + política de lembrete para uma meta.
 *
 * Uso:
 *   npm run diagnose:reminder -- --goalId=<uuid>
 *   npm run diagnose:reminder -- --userId=<uuid>
 *   npm run diagnose:reminder -- --title="Tomar remédio"
 */

import 'dotenv/config';
import { DateTime } from 'luxon';
import { prisma } from '../src/prisma/client';
import { toGoalReminderView } from '../src/modules/goals/goal-reminder.view';
import { ReminderPolicyEngine } from '../src/modules/reminder/policy/reminder-policy.engine';
import { resolveUserTimezone } from '../src/modules/shared/app-timezone';
import { parseInstantInTimezone } from '../src/modules/shared/parse-instant-timezone.util';
import type { ReminderGoalRecord } from '../src/modules/reminder/reminder.types';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function loadGoal(): Promise<ReminderGoalRecord | null> {
  const goalId = arg('goalId');
  const userId = arg('userId');
  const title = arg('title');

  if (goalId) {
    const row = await prisma.goal.findUnique({
      where: { id: goalId },
      include: {
        schedule: true,
        reminder: true,
        user: {
          select: {
            id: true,
            name: true,
            telegramId: true,
            whatsappId: true,
            preferredChannel: true,
            timezone: true,
          },
        },
        plantedTree: {
          select: {
            growthEvents: {
              select: { createdAt: true, progressIndex: true },
              orderBy: { createdAt: 'desc' },
              take: 2,
            },
          },
        },
      },
    });
    return row ? (toGoalReminderView(row) as ReminderGoalRecord) : null;
  }

  const where: Record<string, unknown> = { completed: false };
  if (userId) where.userId = userId;
  if (title) where.title = { contains: title, mode: 'insensitive' };

  const rows = await prisma.goal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: userId || title ? 10 : 1,
    include: {
      schedule: true,
      reminder: true,
      user: {
        select: {
          id: true,
          name: true,
          telegramId: true,
          whatsappId: true,
          preferredChannel: true,
          timezone: true,
        },
      },
      plantedTree: {
        select: {
          growthEvents: {
            select: { createdAt: true, progressIndex: true },
            orderBy: { createdAt: 'desc' },
            take: 2,
          },
        },
      },
    },
  });

  if (rows.length === 0) return null;
  return toGoalReminderView(rows[0]) as ReminderGoalRecord;
}

function printSchedule(goal: ReminderGoalRecord) {
  const tz = resolveUserTimezone(goal.timezone);
  const sc = goal.schedule;
  console.log('\n--- Agenda ---');
  console.log(JSON.stringify(sc, null, 2));
  if (sc?.type === 'once' && sc.at) {
    const parsed = parseInstantInTimezone(sc.at, tz);
    const dbAt = goal.schedule && 'at' in sc ? sc.at : null;
    console.log(`Fuso efetivo: ${tz}`);
    if (parsed?.isValid) {
      console.log(
        `Instante local: ${parsed.setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}`,
      );
      console.log(`UTC: ${parsed.toUTC().toISO()}`);
    } else {
      console.log(`Não foi possível interpretar at=${dbAt}`);
    }
  }
}

function evaluateAt(
  engine: ReminderPolicyEngine,
  goal: ReminderGoalRecord,
  label: string,
  when: DateTime,
) {
  const tz = resolveUserTimezone(goal.timezone);
  const decision = engine.evaluate({
    goal,
    now: when,
    timezone: tz,
    cancelledGoalIds: new Set(),
  });
  console.log(
    `\n--- Política @ ${label} (${when.setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss')}) ---`,
  );
  console.log(JSON.stringify(decision, null, 2));
}

async function main() {
  const goal = await loadGoal();
  if (!goal) {
    console.error('Meta não encontrada. Use --goalId, --userId ou --title.');
    process.exit(1);
  }

  const tz = resolveUserTimezone(goal.timezone);
  const engine = new ReminderPolicyEngine();

  console.log('--- Meta ---');
  console.log({
    id: goal.id,
    userId: goal.userId,
    title: goal.title,
    goalKind: goal.goalKind,
    completed: goal.completed,
    createdAt: goal.createdAt,
    timezone: tz,
    user: goal.user,
  });

  console.log('\n--- GoalReminder ---');
  console.log(JSON.stringify(goal.reminder, null, 2));

  printSchedule(goal);

  const now = DateTime.now();
  evaluateAt(engine, goal, 'agora', now);

  if (goal.schedule?.type === 'once' && goal.schedule.at) {
    const at = parseInstantInTimezone(goal.schedule.at, tz);
    if (at?.isValid) {
      evaluateAt(engine, goal, 'horário agendado', at);
      evaluateAt(engine, goal, '1 min após agendado', at.plus({ minutes: 1 }));
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
