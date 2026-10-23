jest.mock('../../prisma/client', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    growthEvent: { findMany: jest.fn() },
  },
}));

import { prisma } from '../../prisma/client';
import { DateTime } from 'luxon';
import { DashboardService } from './dashboard.service';
import { UserGoalService } from '../goals/user-goal.service';

describe('DashboardService.getDashboardWeek', () => {
  let service: DashboardService;
  const mockGetGoalsForUser = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DashboardService({
      getGoalsForUser: mockGetGoalsForUser,
    } as unknown as UserGoalService);

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'America/Sao_Paulo',
    });
    (prisma.growthEvent.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('weekGrid.occurrences no mesmo shape do Dia (instanceId da célula)', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T07:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-1',
        title: 'Pescar',
        goalKind: 'Continua',
        conquestType: 'Lazer',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['09:30'] },
        plantedTree: { growthEvents: [] },
      },
      {
        id: 'goal-2',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['14:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardWeek('user-1', '2026-08-26');

    expect(result.weekGrid).toHaveLength(7);
    const wednesday = result.weekGrid.find((d) => d.date === '2026-08-26');
    expect(wednesday).toBeDefined();
    expect((wednesday as { goals?: unknown }).goals).toBeUndefined();
    expect(wednesday!.occurrences).toHaveLength(2);
    expect(wednesday!.occurrences[0]).toMatchObject({
      instanceId: 'goal-1:2026-08-26:09:30',
      goalId: 'goal-1',
      title: 'Pescar',
      goalKind: 'Continua',
      conquestType: 'Lazer',
      startTime: '09:30',
      endTime: '10:00',
      status: 'PENDING',
      icon: 'palette',
      accentColor: 'accent-pink',
    });
    expect(wednesday!.occurrences[1]).toMatchObject({
      instanceId: 'goal-2:2026-08-26:14:00',
      goalId: 'goal-2',
      title: 'Beber água',
      startTime: '14:00',
      endTime: '14:30',
      status: 'PENDING',
      icon: 'fitness_center',
      accentColor: 'garden-green',
    });

    jest.restoreAllMocks();
  });

  it('1 occurrence por meta no dia mesmo com vários times', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T07:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardWeek('user-1', '2026-08-26');
    const wednesday = result.weekGrid.find((d) => d.date === '2026-08-26');

    expect(wednesday!.expectedSlots).toBe(2);
    expect(wednesday!.occurrences).toHaveLength(1);
    expect(wednesday!.occurrences[0]).toMatchObject({
      instanceId: 'goal-water:2026-08-26:08:00',
      startTime: '08:00',
      endTime: '08:30',
      schedule: { type: 'daily', times: ['08:00', '18:00'] },
    });
    expect(wednesday!.harvestCount).toBe(0);
    expect(result.weeklyProgress).toEqual({
      percentage: 0,
      total: 7,
      harvested: 0,
    });
    expect(result.harvestCount).toBe(0);

    jest.restoreAllMocks();
  });

  it('weeklyProgress conta ocorrências DONE, não growth events brutos', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T19:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00'] },
        plantedTree: {
          growthEvents: [
            {
              id: 'plant',
              createdAt: new Date('2026-01-01T12:00:00.000Z'),
              progressIndex: 1,
            },
            {
              id: 'harvest-mon',
              createdAt: new Date('2026-08-24T15:00:00.000Z'),
              progressIndex: 2,
            },
          ],
        },
      },
    ]);

    const result = await service.getDashboardWeek('user-1', '2026-08-26');
    const monday = result.weekGrid.find((d) => d.date === '2026-08-24');

    expect(monday!.occurrences[0].status).toBe('DONE');
    expect(monday!.harvestCount).toBe(1);
    expect(result.weeklyProgress).toEqual({
      percentage: 14,
      total: 7,
      harvested: 1,
    });
    expect(result.harvestCount).toBe(1);

    jest.restoreAllMocks();
  });

  it('dois horários às 10:00 segue PENDING e dia passado sem colheita é MISSED', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T10:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardWeek('user-1', '2026-08-26');
    const wednesday = result.weekGrid.find((d) => d.date === '2026-08-26');
    const monday = result.weekGrid.find((d) => d.date === '2026-08-24');

    expect(wednesday!.occurrences).toHaveLength(1);
    expect(wednesday!.occurrences[0].status).toBe('PENDING');
    expect(monday!.occurrences).toHaveLength(1);
    expect(monday!.occurrences[0].status).toBe('MISSED');

    jest.restoreAllMocks();
  });
});

describe('DashboardService.getDashboardDay', () => {
  let service: DashboardService;
  const mockGetGoalsForDateForUser = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DashboardService({
      getGoalsForDateForUser: mockGetGoalsForDateForUser,
    } as unknown as UserGoalService);

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'America/Sao_Paulo',
    });
  });

  it('não propaga dailyStatus DONE de hoje para data futura', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T15:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-1',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        dailyStatus: 'DONE',
        reminder: { dailyStatus: 'DONE' },
        schedule: { type: 'daily', times: ['08:00'] },
        plantedTree: { growthEvents: [] },
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-27');

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].status).toBe('PENDING');
    expect(result.occurrences[0].instanceId).toBe('goal-1:2026-08-27:08:00');

    jest.restoreAllMocks();
  });

  it('hoje com DONE residual de ontem volta PENDING (CONTINUA diária)', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-27T10:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-1',
        title: 'Correr 5km',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        dailyStatus: 'DONE',
        reminderUpdatedAt: '2026-08-26T18:00:00.000-03:00',
        reminder: {
          dailyStatus: 'DONE',
          updatedAt: '2026-08-26T18:00:00.000-03:00',
        },
        schedule: { type: 'daily', times: ['07:00'] },
        plantedTree: {
          growthEvents: [
            { createdAt: '2026-01-01T12:00:00.000Z', progressIndex: 1 },
            { createdAt: '2026-08-26T18:00:00.000-03:00', progressIndex: 2 },
          ],
        },
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-27');

    expect(result.occurrences[0].status).toBe('MISSED');
    expect(result.goals).toBeUndefined();

    jest.restoreAllMocks();
  });

  it('1 occurrence por meta mesmo com vários times; accentColor é token', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-27T07:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        dailyStatus: 'PENDING',
        reminder: { dailyStatus: 'PENDING' },
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: { growthEvents: [] },
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-27');

    expect(result).toEqual({
      date: '2026-08-27',
      occurrences: [
        {
          instanceId: 'goal-water:2026-08-27:08:00',
          goalId: 'goal-water',
          title: 'Beber água',
          goalKind: 'Continua',
          conquestType: 'Corpo',
          schedule: { type: 'daily', times: ['08:00', '18:00'] },
          startTime: '08:00',
          endTime: '08:30',
          status: 'PENDING',
          icon: 'fitness_center',
          accentColor: 'garden-green',
        },
      ],
      harvestSummary: { collected: 0, total: 1 },
    });

    jest.restoreAllMocks();
  });

  it('dois horários às 10:00 fica PENDING, no mesmo status da semana', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T10:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-26');

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].status).toBe('PENDING');
    expect(result.occurrences[0].startTime).toBe('08:00');

    jest.restoreAllMocks();
  });

  it('dia passado sem colheita é MISSED', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T10:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-25');

    expect(result.occurrences[0].status).toBe('MISSED');

    jest.restoreAllMocks();
  });

  it('SKIPPED de hoje não entra na colheita', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T19:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForDateForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        dailyStatus: 'SKIPPED',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardDay('user-1', '2026-08-26');

    expect(result.occurrences[0].status).toBe('SKIPPED');
    expect(result.harvestSummary).toEqual({ collected: 0, total: 1 });

    jest.restoreAllMocks();
  });
});

describe('DashboardService.getDashboardMonth', () => {
  let service: DashboardService;
  const mockGetGoalsForUser = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DashboardService({
      getGoalsForUser: mockGetGoalsForUser,
    } as unknown as UserGoalService);

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      timezone: 'America/Sao_Paulo',
    });
    (prisma.growthEvent.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('monthGrid.occurrences no mesmo shape do Dia (instanceId da célula)', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T07:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-1',
        title: 'Pescar',
        goalKind: 'Continua',
        conquestType: 'Lazer',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['09:30'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardMonth('user-1', '2026-08');
    const day = result.monthGrid.find((d) => d.date === '2026-08-26');

    expect(result.month).toBe('2026-08');
    expect((day as { goals?: unknown }).goals).toBeUndefined();
    expect(day!.occurrences).toHaveLength(1);
    expect(day!.occurrences[0]).toMatchObject({
      instanceId: 'goal-1:2026-08-26:09:30',
      goalId: 'goal-1',
      title: 'Pescar',
      startTime: '09:30',
      endTime: '10:00',
      status: 'PENDING',
      icon: 'palette',
      accentColor: 'accent-pink',
    });
    expect(result.monthlyGoal).toMatchObject({ harvested: 0 });
    expect(result.activeDays).toBe(0);

    jest.restoreAllMocks();
  });

  it('1 occurrence por meta no dia mesmo com vários times', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T07:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: { growthEvents: [] },
      },
    ]);

    const result = await service.getDashboardMonth('user-1', '2026-08-26');
    const day = result.monthGrid.find((d) => d.date === '2026-08-26');

    expect(day!.expectedSlots).toBe(2);
    expect(day!.occurrences).toHaveLength(1);
    expect(day!.occurrences[0]).toMatchObject({
      instanceId: 'goal-water:2026-08-26:08:00',
      startTime: '08:00',
      endTime: '08:30',
      schedule: { type: 'daily', times: ['08:00', '18:00'] },
    });
    expect(result.monthlyGoal.total).toBe(31);
    expect(result.monthlyGoal.harvested).toBe(0);
    expect(result.activeDays).toBe(0);

    jest.restoreAllMocks();
  });

  it('monthlyGoal e activeDays seguem ocorrências DONE no grid', async () => {
    jest.spyOn(DateTime, 'now').mockReturnValue(
      DateTime.fromISO('2026-08-26T19:00:00', {
        zone: 'America/Sao_Paulo',
      }) as DateTime<true>,
    );

    mockGetGoalsForUser.mockResolvedValue([
      {
        id: 'goal-water',
        title: 'Beber água',
        goalKind: 'Continua',
        conquestType: 'Corpo',
        completed: false,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        schedule: { type: 'daily', times: ['08:00', '18:00'] },
        plantedTree: {
          growthEvents: [
            {
              id: 'plant',
              createdAt: new Date('2026-01-01T12:00:00.000Z'),
              progressIndex: 1,
            },
            {
              id: 'harvest-26',
              createdAt: new Date('2026-08-26T12:00:00.000Z'),
              progressIndex: 2,
            },
          ],
        },
      },
    ]);

    const result = await service.getDashboardMonth('user-1', '2026-08-26');
    const day26 = result.monthGrid.find((d) => d.date === '2026-08-26');

    expect(day26!.expectedSlots).toBe(2);
    expect(day26!.occurrences).toHaveLength(1);
    expect(day26!.occurrences[0].status).toBe('DONE');
    expect(day26!.harvestCount).toBe(1);
    expect(result.monthlyGoal.harvested).toBe(1);
    expect(result.activeDays).toBe(1);
  });
});
