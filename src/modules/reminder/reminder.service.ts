import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { prisma } from '../../prisma/client';
import { UserGoalService } from '../goals/user-goal.service';
import { ReminderDeliveryService } from './delivery/reminder-delivery.service';
import { ReminderCopyBuilder } from './copy/reminder-copy.builder';
import { ReminderPolicyEngine } from './policy/reminder-policy.engine';
import { ReminderObservabilityService } from './observability/reminder-observability.service';
import {
  ReminderGoalRecord,
  ReminderPolicyDecision,
} from './reminder.types';
import { getCancelledExceptionsForDate } from '../shared/cancelled-exceptions.query';
import { planUserReminders } from './planning/plan-user-reminders';
import {
  REMINDER_CLAIM_STORE,
  type ClaimSnapshot,
  type ReminderClaimStore,
} from './claim/claim.store';
import { resolveUserTimezone } from '../shared/app-timezone';

const GROUP_WINDOW_MINUTES = Number(
  process.env.REMINDER_GROUP_WINDOW_MINUTES || 60,
);
const GROUP_FOLLOW_UP_MINUTES = Number(
  process.env.REMINDER_GROUP_FOLLOW_UP_MINUTES || 5,
);
const GROUP_LAST_CHANCE_MINUTES = Number(
  process.env.REMINDER_GROUP_LAST_CHANCE_MINUTES || 15,
);

function toSnapshot(g: ReminderGoalRecord): ClaimSnapshot {
  return {
    id: g.id,
    dailyStatus: g.reminder.dailyStatus,
    lastSentAt: g.reminder.lastSentAt,
    silenceUntil: g.reminder.silenceUntil,
    slotsToday: g.reminder.slotsToday,
    sentCount: g.reminder.sentCount || 0,
  };
}

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    private readonly userGoalService: UserGoalService,
    private readonly policyEngine: ReminderPolicyEngine,
    private readonly copyBuilder: ReminderCopyBuilder,
    private readonly deliveryService: ReminderDeliveryService,
    private readonly observability: ReminderObservabilityService,
    @Inject(REMINDER_CLAIM_STORE)
    private readonly claimStore: ReminderClaimStore,
  ) {}

  @Cron('* * * * *')
  async sendReminders() {
    // RISCO DE CONCORRÊNCIA: Este tick não tem lock global — se o processamento
    // demorar mais de 1 minuto (ex: muitos usuários, timeout de LLM), o próximo
    // tick inicia antes do anterior terminar e ambos carregam/avaliam as mesmas metas.
    // A proteção atual é otimista: ReminderClaimStore.claimBatch usa updateMany
    // condicional, evitando duplicação no envio, mas não evita carga duplicada.
    //
    // Para mitigar em produção:
    //   - MVP: Redis SETNX `reminders:tick:lock` com TTL de 60s no início do método
    //   - Escalável: BullMQ — cron enfileira jobs, workers processam com retry nativo
    const goals =
      (await this.userGoalService.getActiveGoalsForReminders()) as ReminderGoalRecord[];
    const now = DateTime.now();

    const byUser = new Map<string, ReminderGoalRecord[]>();
    for (const g of goals) {
      const list = byUser.get(g.userId) || [];
      list.push(g);
      byUser.set(g.userId, list);
    }

    for (const [, userGoals] of byUser) {
      const timezone = resolveUserTimezone(userGoals[0]?.timezone);
      const cancelledGoalIds = await getCancelledExceptionsForDate(
        userGoals.map((g) => g.id).filter((id): id is string => !!id),
        now,
        timezone,
      );
      const { toSend, skipUpdates, evaluations } = planUserReminders({
        userGoals,
        now,
        timezone,
        cancelledGoalIds,
        policyEngine: this.policyEngine,
        groupWindowMinutes: GROUP_WINDOW_MINUTES,
        groupFollowUpMinutes: GROUP_FOLLOW_UP_MINUTES,
        groupLastChanceMinutes: GROUP_LAST_CHANCE_MINUTES,
      });

      for (const ev of evaluations) {
        const goal = userGoals.find((g) => g.id === ev.goalId);
        this.observability.policy({
          goalId: ev.goalId,
          userId: goal?.userId ?? userGoals[0]?.userId,
          action: ev.decision.action,
          kind: ev.decision.kind,
          statusBefore: goal?.reminder.dailyStatus,
          reason: ev.decision.reason,
        });
      }

      for (const item of skipUpdates) {
        await this.userGoalService.updateReminderState(
          item.goal.id,
          item.goal.userId,
          {
            dailyStatus: item.decision.nextStatus,
            silenceUntil: item.decision.silenceUntil ?? null,
          },
        );
      }

      if (toSend.length === 0) continue;

      if (toSend.length >= 2) {
        await this.sendBatch(toSend, now, timezone);
      } else {
        await this.sendSingle(toSend[0], now, timezone);
      }
    }
  }

  private async sendBatch(
    items: { goal: ReminderGoalRecord; decision: ReminderPolicyDecision }[],
    now: DateTime,
    timezone: string,
  ) {
    const goals = items.map((i) => i.goal);
    const decisions = items.map((i) => i.decision);
    const snapshots = goals.map(toSnapshot);

    const marked = await this.claimStore.claimBatch(items, now, timezone);
    if (!marked) {
      this.logClaimFailed(goals);
      return;
    }

    const followUpDecision = decisions.find(
      (d) => d.kind === 'follow_up' || d.kind === 'last_chance',
    );
    const kind = followUpDecision?.kind ?? decisions[0].kind!;

    try {
      const composed = await this.copyBuilder.composeBatch(
        goals,
        kind,
        timezone,
        now.toJSDate(),
        goals[0].userId,
      );
      const delivered = await this.deliveryService.send({
        user: goals[0].user,
        text: composed.text,
        kind,
        goalId: composed.mainGoal.id,
        userId: goals[0].userId,
      });
      if (!delivered) throw new Error('delivery_failed');
      await this.copyBuilder.primeSession(composed);
    } catch (error) {
      this.logger.error(`Erro ao entregar batch de reminders`, error as Error);
      await this.claimStore.rollback(snapshots);
    }
  }

  private async sendSingle(
    item: { goal: ReminderGoalRecord; decision: ReminderPolicyDecision },
    now: DateTime,
    timezone: string,
  ) {
    const { goal, decision } = item;
    const snapshots = [toSnapshot(goal)];

    const marked = await this.claimStore.claimBatch([item], now, timezone);
    if (!marked) {
      this.logClaimFailed([goal]);
      return;
    }

    try {
      const composed = await this.copyBuilder.composeSingle(
        goal,
        decision.kind!,
        timezone,
        now.toJSDate(),
      );
      const delivered = await this.deliveryService.send({
        user: goal.user,
        text: composed.text,
        kind: decision.kind!,
        goalId: goal.id,
        userId: goal.userId,
      });
      if (!delivered) throw new Error('delivery_failed');
      await this.copyBuilder.primeSession(composed);
    } catch (error) {
      this.logger.error(
        `Erro ao entregar reminder para goal=${goal.id}`,
        error as Error,
      );
      await this.claimStore.rollback(snapshots);
    }
  }

  private logClaimFailed(goals: ReminderGoalRecord[]) {
    for (const g of goals) {
      this.logger.warn(
        `reminder_claim_failed goalId=${g.id} userId=${g.userId} dailyStatus=${String(g.reminder.dailyStatus)} lastSentAt=${g.reminder.lastSentAt ?? 'null'}`,
      );
    }
  }

  @Cron('0 0 * * *')
  async resetDailyStatus() {
    await prisma.goalReminder.updateMany({
      where: {
        silenceUntil: { lte: DateTime.now().toUTC().toJSDate() },
        goal: { completed: false },
      },
      data: {
        silenceUntil: null,
      },
    });
  }
}
