import { UserGoalService, resolveScheduleFields } from './user-goal.service';
import { prisma } from '../../prisma/client';
import { DateTime } from 'luxon';
import { BadRequestException } from '@nestjs/common';

jest.mock('../../prisma/client', () => ({
  prisma: {
    goal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    goalReminder: {
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    growthEvent: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    plantedTree: {
      update: jest.fn(),
    },
    goalOccurrenceException: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
  },
}));

describe('resolveScheduleFields', () => {
  it('agenda lembrete pontual HH:MM no futuro para hoje', () => {
    const now = DateTime.fromISO('2026-03-05T17:37:00', {
      zone: 'America/Sao_Paulo',
    });
    jest.spyOn(DateTime, 'now').mockReturnValue(now as DateTime<true>);

    const fields = resolveScheduleFields({
      scheduleConfig: { type: 'once', at: '17:40' },
      goalType: 'Pontual',
      userTimezone: 'America/Sao_Paulo',
    });

    expect(fields.scheduleFrequency).toBe('ONCE');
    const atLocal = DateTime.fromJSDate(fields.scheduleAt!).setZone(
      'America/Sao_Paulo',
    );
    expect(atLocal.toFormat('HH:mm')).toBe('17:40');
    expect(atLocal.day).toBe(5);

    jest.restoreAllMocks();
  });

  it('empurra lembrete pontual HH:MM no passado para o dia seguinte', () => {
    const now = DateTime.fromISO('2026-03-05T17:45:00', {
      zone: 'America/Sao_Paulo',
    });
    jest.spyOn(DateTime, 'now').mockReturnValue(now as DateTime<true>);

    const fields = resolveScheduleFields({
      scheduleConfig: { type: 'once', at: '17:40' },
      goalType: 'Pontual',
      userTimezone: 'America/Sao_Paulo',
    });

    const atLocal = DateTime.fromJSDate(fields.scheduleAt!).setZone(
      'America/Sao_Paulo',
    );
    expect(atLocal.toFormat('HH:mm')).toBe('17:40');
    expect(atLocal.day).toBe(6);

    jest.restoreAllMocks();
  });

  it('persiste DAILY + times para meta continua mesmo com type DAILY do LLM', () => {
    const fields = resolveScheduleFields({
      scheduleConfig: { type: 'DAILY', times: '10:00' } as any,
      goalType: 'Continua',
      userTimezone: 'America/Sao_Paulo',
    });
    expect(fields.scheduleFrequency).toBe('DAILY');
    expect(fields.scheduleTimes).toEqual(['10:00']);
  });
});

describe('UserGoalService', () => {
  let service: UserGoalService;
  let worldsEventsMock: { progressPlantedTree: jest.Mock };
  const mockGoalFindMany = prisma.goal.findMany as jest.Mock;

  // Helper para construir um goal com schedule e reminder no formato do banco
  function makeGoal(overrides: Partial<any> = {}) {
    const now = DateTime.now().setZone('America/Sao_Paulo');
    return {
      id: 'goal-a',
      userId: 'user-1',
      title: 'Ler',
      description: null,
      goalKind: 'Continua',
      conquestType: 'Mente',
      completed: false,
      createdAt: new Date(),
      schedule: {
        id: 'sched-a',
        goalId: 'goal-a',
        frequency: 'DAILY',
        times: [now.toFormat('HH:mm')],
        daysOfWeek: null,
        durationDays: null,
        timeZone: 'America/Sao_Paulo',
        at: null,
        dtStart: null,
        dtEnd: null,
      },
      reminder: {
        id: 'rem-a',
        goalId: 'goal-a',
        dailyStatus: null,
        slotsToday: null,
        lastSentAt: null,
        sentCount: 0,
        silenceUntil: null,
      },
      plantedTree: null,
      user: {
        id: 'user-1',
        name: 'Test',
        telegramId: null,
        timezone: 'America/Sao_Paulo',
      },
      ...overrides,
    };
  }

  function makeInstanceGoalRow(overrides: Partial<any> = {}) {
    return makeGoal({
      id: 'goal-c',
      goalKind: 'Continua',
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      schedule: {
        id: 'sched-c',
        goalId: 'goal-c',
        frequency: 'DAILY',
        times: ['08:00', '18:00'],
        daysOfWeek: null,
        durationDays: null,
        timeZone: 'America/Sao_Paulo',
        at: null,
        dtStart: null,
        dtEnd: null,
      },
      plantedTree: {
        id: 'tree-1',
        worldId: 'world-1',
        growthEvents: [],
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    worldsEventsMock = { progressPlantedTree: jest.fn().mockResolvedValue({}) };
    (prisma.growthEvent.findMany as jest.Mock).mockResolvedValue([]);
    service = new UserGoalService(
      {} as any,
      {} as any,
      {} as any,
      worldsEventsMock as any,
    );
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) =>
      fn({
        growthEvent: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        plantedTree: {
          update: jest.fn().mockResolvedValue({}),
        },
      }),
    );
  });

  describe('getIgnoredGoalsForToday', () => {
    it('inclui metas com status MISSED na lista de pendentes', async () => {
      const now = DateTime.now().setZone('America/Sao_Paulo');
      const todayStart = now.startOf('day').toJSDate();
      const todayEnd = now.endOf('day').toJSDate();

      const goalA = makeGoal({
        id: 'goal-a',
        title: 'Ler',
        conquestType: 'Mente',
      });
      const goalB = makeGoal({
        id: 'goal-b',
        title: 'Orar',
        conquestType: 'Espiritual',
      });

      // 1a chamada: getGoalsForUser (usado por getGoalsForTodayForUser)
      mockGoalFindMany
        .mockResolvedValueOnce([goalA, goalB])
        // 2a chamada: getIgnoredGoalsForToday -> segunda query com filtro reminder
        .mockResolvedValueOnce([
          { id: 'goal-a', title: 'Ler', reminder: { dailyStatus: 'MISSED' } },
        ]);

      const result = await service.getIgnoredGoalsForToday(
        'user-1',
        'America/Sao_Paulo',
        ['goal-b'],
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('goal-a');
      expect(result[0].title).toBe('Ler');
      expect(result[0].dailyStatus).toBe('MISSED');
    });

    it('não trata WAITING_REACTIVATION_REPLY legado como pendente de reativação', async () => {
      const goalA = makeGoal({
        id: 'goal-a',
        title: 'Estudar',
        conquestType: 'Mente',
      });

      mockGoalFindMany.mockResolvedValueOnce([goalA]).mockResolvedValueOnce([]);

      const result = await service.getIgnoredGoalsForToday(
        'user-1',
        'America/Sao_Paulo',
        [],
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('createUserGoalWithTree', () => {
    it('recusa create sem agenda (Goal+Reminder órfãos)', async () => {
      (prisma.goal as unknown as { findFirst: jest.Mock }).findFirst = jest
        .fn()
        .mockResolvedValue(null);
      (prisma as unknown as { treeCatalog?: { findFirst: jest.Mock } }).treeCatalog = {
        findFirst: jest.fn().mockResolvedValue({ id: 'cat-1' }),
      };
      (prisma as unknown as { worldConfig?: { findUnique: jest.Mock } }).worldConfig = {
        findUnique: jest.fn().mockResolvedValue({
          anchors: [{ anchorId: 'a1', treeType: 'ground' }],
        }),
      };
      (prisma as unknown as { plantedTree?: { findFirst: jest.Mock } }).plantedTree = {
        findFirst: jest.fn().mockResolvedValue(null),
      };
      (prisma as unknown as { user?: { findUnique: jest.Mock } }).user = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ timezone: 'America/Sao_Paulo' }),
      };
      (prisma as unknown as { $transaction?: jest.Mock }).$transaction = jest.fn();

      await expect(
        service.createUserGoalWithTree({
          userId: 'user-user-1',
          worldId: 'world-1',
          title: 'Ler',
          description: '10 páginas',
          conquestType: 'Mente',
          goalType: 'Continua',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(
        (prisma as unknown as { $transaction: jest.Mock }).$transaction,
      ).not.toHaveBeenCalled();
    });
  });

  describe('Goal write ownership', () => {
    it('completeGoal recusa meta de outro usuário', async () => {
      (prisma.goal as unknown as { findFirst: jest.Mock }).findFirst = jest
        .fn()
        .mockResolvedValue(null);

      await expect(
        service.completeGoal('goal-a', 'user-other'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completeGoal atualiza com id e userId', async () => {
      (prisma.goal as unknown as { findFirst: jest.Mock }).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'goal-a', userId: 'user-1' });
      (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 1 });

      await service.completeGoal('goal-a', 'user-1');

      expect(
        (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany,
      ).toHaveBeenCalledWith({
        where: { id: 'goal-a', userId: 'user-1' },
        data: { completed: true },
      });
    });
  });

  describe('markGoalDoneFromReminder', () => {
    it('pontual: DONE no reminder e completed na Goal', async () => {
      (prisma.goal as unknown as { findFirst: jest.Mock }).findFirst = jest
        .fn()
        .mockResolvedValue({
          id: 'goal-p',
          userId: 'user-1',
          goalKind: 'Pontual',
        });
      (prisma.goalReminder as unknown as { upsert: jest.Mock }).upsert = jest
        .fn()
        .mockResolvedValue({});
      (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 1 });

      await service.markGoalDoneFromReminder('goal-p', 'user-1');

      expect(
        (prisma.goalReminder as unknown as { upsert: jest.Mock }).upsert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { goalId: 'goal-p' },
          update: { dailyStatus: 'DONE', silenceUntil: null },
        }),
      );
      expect(
        (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany,
      ).toHaveBeenCalledWith({
        where: { id: 'goal-p', userId: 'user-1' },
        data: { completed: true },
      });
    });

    it('continua: DONE no reminder sem completed na Goal', async () => {
      (prisma.goal as unknown as { findFirst: jest.Mock }).findFirst = jest
        .fn()
        .mockResolvedValue({
          id: 'goal-c',
          userId: 'user-1',
          goalKind: 'Continua',
        });
      (prisma.goalReminder as unknown as { upsert: jest.Mock }).upsert = jest
        .fn()
        .mockResolvedValue({});
      (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany = jest.fn();

      await service.markGoalDoneFromReminder('goal-c', 'user-1');

      expect(
        (prisma.goal as unknown as { updateMany: jest.Mock }).updateMany,
      ).not.toHaveBeenCalled();
    });
  });

  describe('complete/undo instanceId', () => {
    const tz = 'America/Sao_Paulo';

    function mockNow(iso: string) {
      const fixed = DateTime.fromISO(iso, { zone: tz });
      jest.spyOn(DateTime, 'now').mockReturnValue(fixed as DateTime<true>);
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('continua: complete grava reminder hoje e registra growth', async () => {
      mockNow('2026-10-15T10:00:00');
      const row = makeInstanceGoalRow();
      (prisma.goal.findFirst as jest.Mock)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ id: 'goal-c' });
      (prisma.goalReminder.upsert as jest.Mock).mockResolvedValue({});

      await service.completeInstanceForUser(
        'goal-c:2026-10-15:08:00',
        'user-1',
      );

      expect(prisma.goalReminder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { goalId: 'goal-c' },
          update: { dailyStatus: 'DONE', silenceUntil: null },
        }),
      );
      expect(worldsEventsMock.progressPlantedTree).toHaveBeenCalledWith(
        'world-1',
        { goalId: 'goal-c', userId: 'user-1' },
      );
      expect(prisma.goal.updateMany).not.toHaveBeenCalled();
    });

    it('continua: segunda complete no mesmo dia é idempotente', async () => {
      mockNow('2026-10-15T10:00:00');
      const row = makeInstanceGoalRow({
        plantedTree: {
          id: 'tree-1',
          worldId: 'world-1',
          growthEvents: [
            {
              id: 'plant',
              stage: 1,
              progressIndex: 1,
              createdAt: '2026-01-01T12:00:00.000Z',
            },
            {
              id: 'harvest',
              stage: 2,
              progressIndex: 2,
              createdAt: '2026-10-15T10:05:00.000-03:00',
            },
          ],
        },
      });
      (prisma.goal.findFirst as jest.Mock)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ id: 'goal-c' });

      await service.completeInstanceForUser(
        'goal-c:2026-10-15:08:00',
        'user-1',
      );

      expect(prisma.goalReminder.upsert).not.toHaveBeenCalled();
      expect(worldsEventsMock.progressPlantedTree).not.toHaveBeenCalled();
    });

    it('pontual: complete marca goal.completed', async () => {
      mockNow('2026-10-15T10:00:00');
      const row = makeInstanceGoalRow({ goalKind: 'Pontual' });
      (prisma.goal.findFirst as jest.Mock)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ id: 'goal-c' });
      (prisma.goalReminder.upsert as jest.Mock).mockResolvedValue({});
      (prisma.goal.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.completeInstanceForUser(
        'goal-c:2026-10-15:08:00',
        'user-1',
      );

      expect(prisma.goal.updateMany).toHaveBeenCalledWith({
        where: { id: 'goal-c', userId: 'user-1' },
        data: { completed: true },
      });
    });

    it('recusa meta de outro usuário', async () => {
      mockNow('2026-10-15T10:00:00');
      (prisma.goal.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.completeInstanceForUser('goal-c:2026-10-15:08:00', 'user-other'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejeita horário que não é o primeiro slot da timeline', async () => {
      mockNow('2026-10-15T10:00:00');
      (prisma.goal.findFirst as jest.Mock).mockResolvedValue(
        makeInstanceGoalRow(),
      );

      await expect(
        service.completeInstanceForUser('goal-c:2026-10-15:18:00', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('instanceId inválido é recusado', async () => {
      await expect(
        service.completeInstanceForUser('nao-e-id', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('undo hoje volta PENDING e remove colheita do dia', async () => {
      mockNow('2026-10-15T20:00:00');
      const row = makeInstanceGoalRow();
      let deleteManyInTx: jest.Mock;
      (prisma.goal.findFirst as jest.Mock)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ id: 'goal-c' });
      (prisma.growthEvent.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: 'plant',
          stage: 1,
          progressIndex: 1,
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        },
        {
          id: 'harvest',
          stage: 2,
          progressIndex: 2,
          createdAt: new Date('2026-10-15T10:05:00.000Z'),
        },
      ]);
      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
        const tx = {
          growthEvent: {
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue([{ stage: 1 }]),
          },
          plantedTree: { update: jest.fn().mockResolvedValue({}) },
        };
        deleteManyInTx = tx.growthEvent.deleteMany;
        return fn(tx);
      });
      (prisma.goalReminder.upsert as jest.Mock).mockResolvedValue({});

      await service.undoInstanceForUser('goal-c:2026-10-15:08:00', 'user-1');

      expect(deleteManyInTx!).toHaveBeenCalledWith({
        where: { id: { in: ['harvest'] } },
      });
      expect(prisma.goalReminder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { goalId: 'goal-c' },
          update: { dailyStatus: 'PENDING', silenceUntil: null },
        }),
      );
    });

    it('undo em dia passado não altera reminder de hoje', async () => {
      mockNow('2026-10-16T10:00:00');
      const row = makeInstanceGoalRow();
      (prisma.goal.findFirst as jest.Mock)
        .mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ id: 'goal-c' });
      (prisma.growthEvent.findMany as jest.Mock).mockResolvedValue([]);

      await service.undoInstanceForUser('goal-c:2026-10-15:08:00', 'user-1');

      expect(prisma.goalReminder.upsert).not.toHaveBeenCalled();
    });
  });
});
