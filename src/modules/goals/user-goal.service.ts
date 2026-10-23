import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma/client';
import { DateTime } from 'luxon';
import { WorldsGateway } from '../worlds/worlds.gateway';
import { inferTypeFromPath } from '../worlds/infer-type-from-path.util';
import {
  normalizeConquestType,
  CONQUEST_TYPES,
} from '../ia/conquest-type.enum';
import { normalizeGoalType } from '../ia/goal-type.util';
import { CommunicationService } from '../shared/communication.service';
import { StorageService } from '../../storage/storage.service';
import type {
  CreateUserGoalInput,
} from '../ia/conversation/flow.types';
import { filterGoalsOnCivilDate } from '../shared/schedule-occurrence.util';
import { toGoalReminderView } from './goal-reminder.view';
import type { ScheduleConfig } from '../../domain/types/schedule-config.type';
import {
  resolveScheduleFields,
  type ResolvedScheduleFields,
} from '../shared/schedule-fields.util';
export type { ResolvedScheduleFields } from '../shared/schedule-fields.util';
export { resolveScheduleFields };
import { getCancelledExceptionsForDate } from '../shared/cancelled-exceptions.query';
import {
  assertTimelineInstanceForGoal,
  isTimelineInstanceDone,
  parseTimelineInstanceId,
} from './goal-instance-occurrence.util';
import { WorldsEventsService } from '../worlds/worlds.events.service';
import {
  getAppTimezone,
  resolveUserTimezone,
} from '../shared/app-timezone';

const DEFAULT_USER_TIMEZONE = getAppTimezone();

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

export interface GoalWithRelations {
  id: string;
  userId?: string;
  title: string;
  description: string | null;
  goalKind: string;
  conquestType: string;
  status?: string;
  completed: boolean;
  createdAt: Date;
  schedule: GoalScheduleRecord | null;
  reminder: GoalReminderRecord | null;
  plantedTree?: any;
  user?: any;
}

export interface GoalScheduleRecord {
  id: string;
  goalId: string;
  frequency: string;
  at?: Date | null;
  times?: any; // string[] as Json
  daysOfWeek?: any; // number[] as Json
  durationDays?: number | null;
  timeZone: string;
  dtStart?: Date | null;
  dtEnd?: Date | null;
  extra?: unknown;
}

export interface GoalReminderRecord {
  id: string;
  goalId: string;
  dailyStatus?: string | null;
  slotsToday?: any; // { time: string }[] as Json
  lastSentAt?: Date | null;
  sentCount: number;
  silenceUntil?: Date | null;
}


@Injectable()
export class UserGoalService {
  createGoal(arg0: any) {
    throw new Error('Method not implemented.');
  }
  private readonly logger = new Logger(UserGoalService.name);

  constructor(
    private readonly worldsGateway: WorldsGateway,
    private readonly communicationService: CommunicationService,
    private readonly storageService: StorageService,
    private readonly worldsEventsService: WorldsEventsService,
  ) {}

  /**
   * Cria uma meta de usuário (Goal), a árvore (PlantedTree), o GoalSchedule
   * e o GoalReminder inicial em uma única transação.
   * Único writer de Goal no app (API, eventos, conversation executor).
   */
  async createUserGoalWithTree(
    data: Omit<CreateUserGoalInput, 'reminderTime'> & {
      reminderTime?: Date | string;
      scheduleConfig?: ScheduleConfig;
    },
  ) {
    // 0. Verificar se a meta já existe (deduplicação)
    const existingGoal = await prisma.goal.findFirst({
      where: {
        userId: data.userId,
        title: data.title,
        status: 'ACTIVE',
      },
    });

    if (existingGoal) {
      const userTimezone = await this.getUserTimezone(data.userId);
      const scheduleFields = resolveScheduleFields({
        scheduleConfig:
          data.scheduleConfig ?? (data as { schedule?: unknown }).schedule,
        reminderTime: data.reminderTime,
        goalType: data.goalType || 'Pontual',
        userTimezone,
      });

      if (scheduleFields.scheduleFrequency) {
        this.logger.warn(
          `Meta duplicada "${data.title}": atualizando schedule existente (goalId=${existingGoal.id})`,
        );
        await this.applyScheduleFieldsToGoal(
          existingGoal.id,
          data.userId,
          scheduleFields,
          userTimezone,
        );
      } else {
        this.logger.warn(
          `Meta duplicada detectada: "${data.title}" já existe para o usuário. Retornando meta existente.`,
        );
      }

      return prisma.goal.findUniqueOrThrow({
        where: { id: existingGoal.id },
        include: { schedule: true, reminder: true, plantedTree: true },
      });
    }

    // 1. Normalizar e validar conquestType
    const normalizedConquest = normalizeConquestType(data.conquestType);
    if (!normalizedConquest) {
      throw new BadRequestException(
        `conquestType inválido: '${data.conquestType}'. Opções válidas: ${CONQUEST_TYPES.join(', ')}`,
      );
    }

    // 1b. Mapear conquestType → family da árvore
    const conquest = String(normalizedConquest).toLowerCase();
    let family = 'b';
    if (data.goalType && data.goalType.toLowerCase() === 'pontual') {
      switch (true) {
        case conquest.includes('corpo'):
          family = 'a';
          break;
        case conquest.includes('espiritual'):
          family = 'b';
          break;
        case conquest.includes('financeiro'):
          family = 'c';
          break;
        case conquest.includes('hobby') || conquest.includes('lazer'):
          family = 'd';
          break;
        default:
          family = 'b';
      }
    } else {
      switch (true) {
        case conquest.includes('corpo') ||
          conquest.includes('espiritual') ||
          conquest.includes('saud') ||
          conquest.includes('agua'):
          family = 'a';
          break;
        case conquest.includes('financeiro'):
          family = 'c';
          break;
        case conquest.includes('hobby') || conquest.includes('lazer'):
          family = 'd';
          break;
        default:
          family = 'b';
      }
    }

    let type = 'continua';
    const ng = normalizeGoalType(data.goalType as any);
    if (ng === 'Pontual') type = 'pontual';
    else if (ng === 'Continua') type = 'continua';
    else if ('path' in data && typeof (data as any).path === 'string') {
      type = inferTypeFromPath((data as any).path);
    }
    const normalizedGoalType =
      ng ?? (type === 'pontual' ? 'Pontual' : 'Continua');

    const treeCatalog = await prisma.treeCatalog.findFirst({
      where: { family, type },
    });
    if (!treeCatalog) {
      throw new BadRequestException(
        `Tipo de árvore (family='${family}', type='${type}') não encontrado no catálogo para conquestType '${data.conquestType}'`,
      );
    }

    // 2. Buscar anchor livre no mundo
    const worldConfig = await prisma.worldConfig.findUnique({
      where: { worldId: data.worldId },
    });
    if (!worldConfig) {
      throw new BadRequestException(
        'Configuração de anchors não encontrada para o mundo: worldConfig ausente.',
      );
    }
    if (
      !worldConfig.anchors ||
      (Array.isArray(worldConfig.anchors) && worldConfig.anchors.length === 0)
    ) {
      throw new BadRequestException(
        'Configuração de anchors presente mas vazia.',
      );
    }

    let anchorsArr: any[] = [];
    if (Array.isArray(worldConfig.anchors)) {
      anchorsArr = worldConfig.anchors;
    } else if (
      worldConfig.anchors &&
      typeof worldConfig.anchors === 'object' &&
      'anchors' in worldConfig.anchors &&
      Array.isArray((worldConfig.anchors as any).anchors)
    ) {
      anchorsArr = (worldConfig.anchors as any).anchors;
    }

    const isPontual = type === 'pontual';
    let chosenAnchorId: string | null = null;
    for (const anchor of anchorsArr) {
      const aid =
        anchor && (anchor.anchorId || anchor.id || anchor.slot || '')
          ? String(anchor.anchorId || anchor.id || anchor.slot)
          : '';
      if (!aid) continue;
      const at =
        anchor && (anchor.treeType || anchor.type || anchor.dataType)
          ? String(
              anchor.treeType || anchor.type || anchor.dataType,
            ).toLowerCase()
          : '';
      if (isPontual) {
        if (at !== 'sky') continue;
      } else {
        if (at === 'sky') continue;
      }
      const exists = await prisma.plantedTree.findFirst({
        where: {
          worldId: data.worldId,
          anchorId: aid,
          goal: { is: { userId: data.userId } },
        },
      });
      if (!exists) {
        chosenAnchorId = aid;
        break;
      }
    }
    if (!chosenAnchorId) {
      if (isPontual)
        throw new BadRequestException(
          'Não há anchors livres do tipo "sky" disponíveis para este usuário neste mundo',
        );
      throw new BadRequestException(
        'Não há anchors livres disponíveis para este usuário neste mundo',
      );
    }

    // 3. Validações
    if (
      !data.userId ||
      typeof data.userId !== 'string' ||
      data.userId.length < 10
    ) {
      throw new Error('userId inválido ao criar meta: ' + String(data.userId));
    }

    // 3a. Determinar timezone do usuário
    const userTimezone = await this.getUserTimezone(data.userId);

    // 3b. Interpreter scheduleConfig → dados do GoalSchedule
    const {
      scheduleFrequency,
      scheduleAt,
      scheduleTimes,
      scheduleDaysOfWeek,
      scheduleDurationDays,
      scheduleExtra,
    } = resolveScheduleFields({
      scheduleConfig:
        data.scheduleConfig ?? (data as { schedule?: unknown }).schedule,
      reminderTime: data.reminderTime,
      goalType: normalizedGoalType,
      userTimezone,
    });

    if (!scheduleFrequency) {
      throw new BadRequestException(
        'Agenda obrigatória: informe scheduleConfig ou reminderTime para criar a meta com lembrete.',
      );
    }

    // 3c. Título/descrição (gera via IA se vazio)
    let title = data.title || '';
    let description = data.description || '';
    if ((!title || !description) && data.userId) {
      try {
        const md = await this.communicationService.generateProgressMetadata(
          data.userId,
          { goalTitle: title },
        );
        title = title || md.title;
        description = description || md.description;
      } catch {
        /* ignore */
      }
    }

    // 4. Transação: PlantedTree → GrowthEvent → Goal → GoalSchedule → GoalReminder
    const txResult = await prisma.$transaction(async (tx) => {
      const planted = await tx.plantedTree.create({
        data: {
          worldId: data.worldId,
          anchorId: chosenAnchorId,
          treeCatalogId: treeCatalog.id,
          actualStage: 1,
        },
      });

      await tx.growthEvent.create({
        data: {
          plantedTreeId: planted.id,
          stage: 1,
          progressIndex: 1,
          title,
          description,
        },
      });

      const goal = await tx.goal.create({
        data: {
          userId: data.userId,
          title,
          description,
          conquestType: normalizedConquest,
          goalKind: normalizedGoalType,
          plantedTreeId: planted.id,
        },
      });

      // Criar GoalSchedule se há configuração de agendamento
      if (scheduleFrequency) {
        await tx.goalSchedule.create({
          data: {
            goalId: goal.id,
            frequency: scheduleFrequency,
            timeZone: userTimezone,
            at: scheduleAt ?? undefined,
            times:
              scheduleTimes != null
                ? (scheduleTimes as Prisma.InputJsonValue)
                : undefined,
            daysOfWeek:
              scheduleDaysOfWeek != null
                ? (scheduleDaysOfWeek as Prisma.InputJsonValue)
                : undefined,
            durationDays: scheduleDurationDays ?? undefined,
            extra: scheduleExtra
              ? (scheduleExtra as Prisma.InputJsonValue)
              : undefined,
            dtStart:
              scheduleAt ??
              (scheduleTimes
                ? DateTime.now().setZone(userTimezone).toJSDate()
                : undefined),
          },
        });
      }

      // Criar GoalReminder com estado inicial
      await tx.goalReminder.create({
        data: {
          goalId: goal.id,
          dailyStatus: null,
          sentCount: 0,
        },
      });

      return { planted, goal };
    });

    const plantedTreeFull = await prisma.plantedTree.findUnique({
      where: { id: txResult.planted.id },
      include: { treeCatalog: true },
    });

    this.worldsGateway.emitTreePlanted(
      data.worldId,
      await this.storageService.signPlantedTree(plantedTreeFull),
      data.userId,
    );
    this.worldsGateway.emitTreeProgress(
      data.worldId,
      txResult.planted.id,
      1,
      undefined,
      data.userId,
    );

    return txResult.goal;
  }

  private async requireGoalOwnedByUser(goalId: string, userId: string) {
    const existing = await prisma.goal.findFirst({
      where: { id: goalId, userId },
    });
    if (!existing) {
      throw new BadRequestException('Meta não encontrada');
    }
    return existing;
  }

  /**
   * Marca uma meta como concluída
   */
  async completeGoal(goalId: string, userId: string) {
    await this.requireGoalOwnedByUser(goalId, userId);
    await prisma.goal.updateMany({
      where: { id: goalId, userId },
      data: { completed: true },
    });
    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  private async loadGoalForInstanceOperation(goalId: string, userId: string) {
    const row = await prisma.goal.findFirst({
      where: { id: goalId, userId },
      select: {
        id: true,
        userId: true,
        title: true,
        description: true,
        goalKind: true,
        conquestType: true,
        completed: true,
        createdAt: true,
        schedule: {
          select: {
            id: true,
            goalId: true,
            frequency: true,
            at: true,
            times: true,
            daysOfWeek: true,
            durationDays: true,
            timeZone: true,
            extra: true,
          },
        },
        reminder: {
          select: {
            id: true,
            goalId: true,
            dailyStatus: true,
            slotsToday: true,
            lastSentAt: true,
            sentCount: true,
            silenceUntil: true,
            updatedAt: true,
          },
        },
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
            id: true,
            worldId: true,
            growthEvents: {
              select: {
                id: true,
                stage: true,
                createdAt: true,
                progressIndex: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    if (!row) {
      throw new BadRequestException('Meta não encontrada');
    }
    return { row, view: toGoalReminderView(row) };
  }

  private async revertHarvestEventsOnCivilDay(
    plantedTreeId: string,
    day: DateTime,
    tz: string,
  ): Promise<void> {
    const events = await prisma.growthEvent.findMany({
      where: { plantedTreeId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, stage: true, createdAt: true, progressIndex: true },
    });
    if (events.length === 0) return;

    const sorted = [...events];
    const initialEvent =
      sorted[0]?.progressIndex === 1 ? sorted[0] : null;
    const dayStart = day.setZone(tz).startOf('day');
    const dayEnd = day.setZone(tz).endOf('day');

    const toDelete = sorted.filter((ev) => {
      if (initialEvent && ev.id === initialEvent.id) return false;
      const at = DateTime.fromJSDate(new Date(ev.createdAt)).setZone(tz);
      return at >= dayStart && at <= dayEnd;
    });

    if (toDelete.length === 0) return;

    await prisma.$transaction(async (tx) => {
      await tx.growthEvent.deleteMany({
        where: { id: { in: toDelete.map((e) => e.id) } },
      });
      const remaining = await tx.growthEvent.findMany({
        where: { plantedTreeId },
        select: { stage: true },
      });
      const actualStage = remaining.reduce(
        (max, e) => Math.max(max, e.stage),
        1,
      );
      await tx.plantedTree.update({
        where: { id: plantedTreeId },
        data: { actualStage },
      });
    });
  }

  async completeInstanceForUser(rawId: string, userId: string) {
    const { goalId, date, startTime } = parseTimelineInstanceId(rawId);
    const { row, view } = await this.loadGoalForInstanceOperation(
      goalId,
      userId,
    );
    const tz = view.timezone;
    const now = DateTime.now();
    const day = assertTimelineInstanceForGoal(
      view,
      date,
      startTime,
      tz,
      now,
    );

    if (isTimelineInstanceDone(view, day, tz)) {
      return prisma.goal.findFirst({ where: { id: goalId, userId } });
    }

    const isToday = day.hasSame(now.setZone(tz), 'day');
    if (isToday) {
      await prisma.goalReminder.upsert({
        where: { goalId },
        update: { dailyStatus: 'DONE', silenceUntil: null },
        create: { goalId, dailyStatus: 'DONE', sentCount: 0 },
      });
    }

    const actualType = normalizeGoalType(view.goalKind);
    if (actualType === 'Pontual') {
      await prisma.goal.updateMany({
        where: { id: goalId, userId },
        data: { completed: true },
      });
    }

    const planted = row.plantedTree;
    if (planted?.worldId) {
      try {
        await this.worldsEventsService.progressPlantedTree(planted.worldId, {
          goalId,
          userId,
        });
      } catch (err) {
        this.logger.warn(
          `completeInstance: falha ao registrar growth event goalId=${goalId}`,
          err,
        );
      }
    }

    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  async undoInstanceForUser(rawId: string, userId: string) {
    const { goalId, date, startTime } = parseTimelineInstanceId(rawId);
    const { row, view } = await this.loadGoalForInstanceOperation(
      goalId,
      userId,
    );
    const tz = view.timezone;
    const now = DateTime.now();
    const day = assertTimelineInstanceForGoal(
      view,
      date,
      startTime,
      tz,
      now,
    );

    const plantedTreeId = row.plantedTree?.id;
    if (plantedTreeId) {
      await this.revertHarvestEventsOnCivilDay(plantedTreeId, day, tz);
    }

    const isToday = day.hasSame(now.setZone(tz), 'day');
    if (isToday) {
      await prisma.goalReminder.upsert({
        where: { goalId },
        update: { dailyStatus: 'PENDING', silenceUntil: null },
        create: { goalId, dailyStatus: 'PENDING', sentCount: 0 },
      });
    }

    const actualType = normalizeGoalType(view.goalKind);
    if (actualType === 'Pontual') {
      await prisma.goal.updateMany({
        where: { id: goalId, userId },
        data: { completed: false },
      });
    }

    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  async getGoalForUser(goalId: string, userId: string) {
    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  async updateGoalForUser(
    goalId: string,
    userId: string,
    data: Record<string, unknown>,
  ) {
    await this.requireGoalOwnedByUser(goalId, userId);
    const allowed: Record<string, unknown> = {};
    if (typeof data.title === 'string') allowed.title = data.title;
    if (typeof data.description === 'string')
      allowed.description = data.description;
    await prisma.goal.updateMany({
      where: { id: goalId, userId },
      data: allowed,
    });
    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  async deleteGoalForUser(goalId: string, userId: string) {
    const result = await prisma.goal.deleteMany({
      where: { id: goalId, userId },
    });
    if (result.count === 0) {
      throw new BadRequestException('Meta não encontrada');
    }
    return { id: goalId };
  }

  async skipGoalForToday(
    goalId: string,
    userId: string,
    timezone?: string,
    now = DateTime.now(),
  ) {
    await this.requireGoalOwnedByUser(goalId, userId);
    const tz = timezone || (await this.getUserTimezone(userId));
    const silenceUntil = now.setZone(tz).endOf('day').toJSDate();
    return this.updateReminderState(goalId, userId, {
      dailyStatus: 'SKIPPED',
      silenceUntil,
    });
  }

  async markGoalDoneFromReminder(
    goalId: string,
    userId: string,
    goalType?: string,
  ) {
    const goal = await this.requireGoalOwnedByUser(goalId, userId);
    const actualType = goal?.goalKind
      ? normalizeGoalType(goal.goalKind)
      : normalizeGoalType(goalType as any);

    if (actualType === 'Continua') {
      await prisma.goalReminder.upsert({
        where: { goalId },
        update: { dailyStatus: 'DONE', silenceUntil: null },
        create: { goalId, dailyStatus: 'DONE', sentCount: 0 },
      });
      return prisma.goal.findFirst({ where: { id: goalId, userId } });
    }

    await prisma.goalReminder.upsert({
      where: { goalId },
      update: { dailyStatus: 'DONE', silenceUntil: null },
      create: { goalId, dailyStatus: 'DONE', sentCount: 0 },
    });
    await prisma.goal.updateMany({
      where: { id: goalId, userId },
      data: { completed: true },
    });
    return prisma.goal.findFirst({ where: { id: goalId, userId } });
  }

  private async applyScheduleFieldsToGoal(
    goalId: string,
    userId: string,
    fields: ResolvedScheduleFields,
    userTimezone: string,
  ) {
    await this.requireGoalOwnedByUser(goalId, userId);
    if (!fields.scheduleFrequency) return;

    await prisma.$transaction(async (tx) => {
      await tx.goalSchedule.upsert({
        where: { goalId },
        create: {
          goalId,
          frequency: fields.scheduleFrequency!,
          at: fields.scheduleAt,
          times:
            fields.scheduleTimes != null
              ? (fields.scheduleTimes as Prisma.InputJsonValue)
              : undefined,
          daysOfWeek:
            fields.scheduleDaysOfWeek != null
              ? (fields.scheduleDaysOfWeek as Prisma.InputJsonValue)
              : undefined,
          durationDays: fields.scheduleDurationDays,
          timeZone: userTimezone,
          extra: fields.scheduleExtra
            ? (fields.scheduleExtra as Prisma.InputJsonValue)
            : undefined,
        },
        update: {
          frequency: fields.scheduleFrequency!,
          at: fields.scheduleAt,
          times:
            fields.scheduleTimes != null
              ? (fields.scheduleTimes as Prisma.InputJsonValue)
              : undefined,
          daysOfWeek:
            fields.scheduleDaysOfWeek != null
              ? (fields.scheduleDaysOfWeek as Prisma.InputJsonValue)
              : undefined,
          durationDays: fields.scheduleDurationDays,
          timeZone: userTimezone,
          extra: fields.scheduleExtra
            ? (fields.scheduleExtra as Prisma.InputJsonValue)
            : undefined,
        },
      });

      await tx.goalReminder.upsert({
        where: { goalId },
        create: {
          goalId,
          dailyStatus: null,
          slotsToday: [],
          lastSentAt: null,
          sentCount: 0,
          silenceUntil: null,
        },
        update: {
          dailyStatus: null,
          slotsToday: [],
          lastSentAt: null,
          silenceUntil: null,
        },
      });
    });
  }

  async updateReminderState(
    goalId: string,
    userId: string,
    data: { dailyStatus?: string | null; silenceUntil?: Date | null },
  ) {
    await this.requireGoalOwnedByUser(goalId, userId);

    return prisma.goalReminder.upsert({
      where: { goalId },
      update: {
        ...(data.dailyStatus !== undefined
          ? { dailyStatus: data.dailyStatus }
          : {}),
        ...(data.silenceUntil !== undefined
          ? { silenceUntil: data.silenceUntil }
          : {}),
      },
      create: {
        goalId,
        dailyStatus: data.dailyStatus ?? null,
        silenceUntil: data.silenceUntil ?? null,
        sentCount: 0,
      },
    });
  }

  /**
   * Busca metas ativas para lembretes (com schedule e reminder incluídos)
   */
  async getActiveGoalsForReminders() {
    const goals = await prisma.goal.findMany({
      where: {
        completed: false,
        schedule: {
          isNot: null,
        },
      },
      select: {
        id: true,
        userId: true,
        title: true,
        description: true,
        goalKind: true,
        conquestType: true,
        completed: true,
        createdAt: true,
        schedule: {
          select: {
            id: true,
            goalId: true,
            frequency: true,
            at: true,
            times: true,
            daysOfWeek: true,
            durationDays: true,
            timeZone: true,
            dtStart: true,
            dtEnd: true,
            extra: true,
          },
        },
        reminder: {
          select: {
            id: true,
            goalId: true,
            dailyStatus: true,
            slotsToday: true,
            lastSentAt: true,
            sentCount: true,
            silenceUntil: true,
            updatedAt: true,
          },
        },
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
              select: {
                createdAt: true,
                progressIndex: true,
              },
              orderBy: { createdAt: 'desc' },
              take: 2,
            },
          },
        },
      },
    });

    return goals.map(toGoalReminderView);
  }

  async getGoalsByIds(goalIds: string[]) {
    if (goalIds.length === 0) return [];
    return prisma.goal.findMany({
      where: { id: { in: goalIds } },
      select: { id: true, title: true },
    });
  }

  async getIgnoredGoalsForToday(
    userId: string,
    timezone = DEFAULT_USER_TIMEZONE,
    excludeGoalIds: string[] = [],
  ) {
    const todayGoals = await this.getGoalsForTodayForUser(userId, timezone);
    const now = DateTime.now().setZone(timezone);
    const todayStart = now.startOf('day').toJSDate();
    const todayEnd = now.endOf('day').toJSDate();

    const todayGoalIds = todayGoals
      .map((g: any) => g.id)
      .filter((id: string) => !excludeGoalIds.includes(id));
    if (todayGoalIds.length === 0) return [];

    const ignored = await prisma.goal.findMany({
      where: {
        userId,
        id: { in: todayGoalIds },
        completed: false,
        reminder: {
          lastSentAt: { gte: todayStart, lte: todayEnd },
          dailyStatus: {
            in: [
              'WAITING_OPERATIONAL_REPLY',
              'WAITING_FOLLOW_UP_REPLY',
              'MISSED',
            ],
          },
        },
      },
      select: {
        id: true,
        title: true,
        reminder: { select: { dailyStatus: true } },
      },
    });

    return ignored.map((g) => ({
      id: g.id,
      title: g.title,
      dailyStatus: g.reminder?.dailyStatus ?? null,
    }));
  }

  async getGoalsForTodayWithStatus(
    userId: string,
    timezone = DEFAULT_USER_TIMEZONE,
  ) {
    const todayGoals = await this.getGoalsForTodayForUser(userId, timezone);
    const now = DateTime.now().setZone(timezone).toJSDate();

    const goals = await prisma.goal.findMany({
      where: {
        userId,
        id: { in: todayGoals.map((g: any) => g.id) },
        completed: false,
      },
      select: {
        id: true,
        title: true,
        completed: true,
        reminder: { select: { dailyStatus: true, silenceUntil: true } },
      },
    });

    return goals
      .filter((g) => {
        const silenceUntil = g.reminder?.silenceUntil
          ? new Date(g.reminder.silenceUntil)
          : null;
        if (silenceUntil && silenceUntil > now) return false;
        return true;
      })
      .map((g) => ({
        id: g.id,
        title: g.title,
        completed: g.completed,
        dailyStatus: g.reminder?.dailyStatus ?? null,
        silenceUntil: g.reminder?.silenceUntil ?? null,
      }));
  }

  async getGoalsForDateForUser(
    userId: string,
    targetDate: DateTime,
    timezone = DEFAULT_USER_TIMEZONE,
    options?: { includeCompleted?: boolean },
  ) {
    const all = await this.getGoalsForUser(userId);
    const goalIds = all
      .map((g: { id?: string }) => g.id)
      .filter((id: string | undefined): id is string => !!id);
    const cancelledGoalIds = await getCancelledExceptionsForDate(
      goalIds,
      targetDate,
      timezone,
    );
    const includeCompleted = options?.includeCompleted ?? false;

    return filterGoalsOnCivilDate(all, targetDate, timezone).filter(
      (g: { id?: string; goalKind?: string; completed?: boolean }) => {
        if (g.id && cancelledGoalIds.has(g.id)) return false;
        const isPontualCompleted =
          g.goalKind === 'Pontual' && g.completed === true;
        if (!includeCompleted && isPontualCompleted) return false;
        return true;
      },
    );
  }

  async getGoalsForTodayForUser(
    userId: string,
    timezone = DEFAULT_USER_TIMEZONE,
  ) {
    const now = DateTime.now().setZone(timezone);
    return this.getGoalsForDateForUser(userId, now, timezone, {
      includeCompleted: false,
    });
  }

  async getGoalsForTomorrowForUser(
    userId: string,
    timezone = DEFAULT_USER_TIMEZONE,
  ) {
    const now = DateTime.now().setZone(timezone);
    const tomorrow = now.plus({ days: 1 });
    return this.getGoalsForDateForUser(userId, tomorrow, timezone, {
      includeCompleted: false,
    });
  }

  /**
   * Carrega apenas o timezone do usuário
   */
  async getUserTimezone(userId: string): Promise<string> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      return resolveUserTimezone(user?.timezone);
    } catch {
      return DEFAULT_USER_TIMEZONE;
    }
  }

  async getGoalsForUser(userId: string) {
    const goals = await prisma.goal.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        title: true,
        description: true,
        goalKind: true,
        conquestType: true,
        completed: true,
        createdAt: true,
        schedule: {
          select: {
            id: true,
            goalId: true,
            frequency: true,
            at: true,
            times: true,
            daysOfWeek: true,
            durationDays: true,
            timeZone: true,
            extra: true,
          },
        },
        reminder: {
          select: {
            id: true,
            goalId: true,
            dailyStatus: true,
            slotsToday: true,
            lastSentAt: true,
            sentCount: true,
            silenceUntil: true,
            updatedAt: true,
          },
        },
        plantedTree: {
          select: {
            id: true,
            anchorId: true,
            actualStage: true,
            createdAt: true,
            treeCatalog: {
              select: { family: true, type: true },
            },
            growthEvents: {
              select: {
                id: true,
                stage: true,
                createdAt: true,
                title: true,
                description: true,
                progressIndex: true,
              },
              orderBy: { createdAt: 'desc' },
              take: 30,
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' }, // Ordenar por data de criação descendente
    });

    // 🔴 DEDUPLICAÇÃO: Manter apenas a meta mais recente de cada título
    const seen = new Map<string, (typeof goals)[0]>();
    for (const goal of goals) {
      const key = `${goal.title}`.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, goal);
      }
    }
    const dedupedGoals = Array.from(seen.values());

    this.logger.debug(
      `getGoalsForUser: ${goals.length} metas no total → ${dedupedGoals.length} após deduplicação`,
    );

    return dedupedGoals.map(toGoalReminderView);
  }
}
