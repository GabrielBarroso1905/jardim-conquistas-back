import { DateTime } from 'luxon';
import {
  expectedSlotCountForGoalOnDate,
  normalizeTimeToHHmm,
  resolveDailyStatusForDate,
  resolveOccurrenceStatus,
  scheduledTimesForGoalOnDate,
  coerceScheduleConfig,
  occurrencesOnCivilDate,
  isOccurrenceDue,
  filterGoalsOnCivilDate,
} from './schedule-occurrence.util';

describe('scheduledTimesForGoalOnDate', () => {
  const tz = 'America/Sao_Paulo';
  const createdAt = new Date('2026-01-01T12:00:00.000Z');

  it('retorna horários normalizados para meta daily', () => {
    const day = DateTime.fromISO('2026-08-26', { zone: tz });
    const times = scheduledTimesForGoalOnDate(
      {
        createdAt,
        scheduleConfig: { type: 'daily', times: ['7:00', '18:00'] },
      },
      day,
      tz,
    );
    expect(times).toEqual(['07:00', '18:00']);
    expect(
      expectedSlotCountForGoalOnDate(
        {
          createdAt,
          scheduleConfig: { type: 'daily', times: ['7:00', '18:00'] },
        },
        day,
        tz,
      ),
    ).toBe(2);
  });

  it('retorna times em weekly apenas nos dias configurados', () => {
    const goal = {
      createdAt,
      scheduleConfig: { type: 'weekly', daysOfWeek: [3], times: ['09:30'] },
    };
    const wednesday = DateTime.fromISO('2026-08-26', { zone: tz });
    const thursday = DateTime.fromISO('2026-08-27', { zone: tz });

    expect(scheduledTimesForGoalOnDate(goal, wednesday, tz)).toEqual(['09:30']);
    expect(scheduledTimesForGoalOnDate(goal, thursday, tz)).toEqual([]);
  });

  it('occurrencesOnCivilDate expõe civilDate + HH:MM', () => {
    const day = DateTime.fromISO('2026-08-26T12:00:00', { zone: tz });
    const occs = occurrencesOnCivilDate(
      {
        createdAt,
        scheduleConfig: { type: 'daily', times: ['08:00', '18:00'] },
      },
      day,
      tz,
    );
    expect(occs.map((o) => o.hhmm)).toEqual(['08:00', '18:00']);
    expect(occs[0].civilDate).toBe('2026-08-26');
    expect(
      isOccurrenceDue(
        occs[0],
        DateTime.fromISO('2026-08-26T07:59:00', { zone: tz }),
      ),
    ).toBe(false);
    expect(
      isOccurrenceDue(
        occs[0],
        DateTime.fromISO('2026-08-26T08:00:00', { zone: tz }),
      ),
    ).toBe(true);
  });

  it('retorna HH:mm de meta once no fuso do usuário', () => {
    const day = DateTime.fromISO('2026-08-26', { zone: tz });
    const times = scheduledTimesForGoalOnDate(
      {
        createdAt,
        scheduleConfig: { type: 'once', at: '2026-08-26T14:30:00.000-03:00' },
      },
      day,
      tz,
    );
    expect(times).toEqual(['14:30']);
  });

  it('retorna [] quando meta não tem ocorrência no dia', () => {
    const day = DateTime.fromISO('2026-08-26', { zone: tz });
    expect(
      scheduledTimesForGoalOnDate(
        {
          createdAt,
          scheduleConfig: { type: 'monthly', dayOfMonth: 15, times: ['10:00'] },
        },
        day,
        tz,
      ),
    ).toEqual([]);
  });

  it('filterGoalsOnCivilDate usa a mesma regra de ocorrência', () => {
    const wed = DateTime.fromISO('2026-08-26', { zone: tz });
    const thu = DateTime.fromISO('2026-08-27', { zone: tz });
    const weekly = {
      createdAt,
      scheduleConfig: {
        type: 'weekly' as const,
        daysOfWeek: [3],
        times: ['09:30'],
      },
    };
    const daily = {
      createdAt,
      scheduleConfig: { type: 'daily' as const, times: ['08:00', '18:00'] },
    };
    expect(filterGoalsOnCivilDate([weekly, daily], wed, tz)).toEqual([
      weekly,
      daily,
    ]);
    expect(filterGoalsOnCivilDate([weekly, daily], thu, tz)).toEqual([daily]);
  });
});

describe('normalizeTimeToHHmm', () => {
  it('normaliza horários com um dígito', () => {
    expect(normalizeTimeToHHmm('8:00')).toBe('08:00');
    expect(normalizeTimeToHHmm('08:00:00')).toBe('08:00');
  });

  it('normaliza 10h e 10h00', () => {
    expect(normalizeTimeToHHmm('10h')).toBe('10:00');
    expect(normalizeTimeToHHmm('10h00')).toBe('10:00');
  });

  it('retorna null para valor inválido', () => {
    expect(normalizeTimeToHHmm('invalid')).toBeNull();
  });

  it('ISO sem offset usa timezone do usuário para HH:mm', () => {
    expect(
      normalizeTimeToHHmm('2026-09-02T09:00:00', 'America/Fortaleza'),
    ).toBe('09:00');
  });
});

describe('coerceScheduleConfig', () => {
  it('converte type DAILY e times string em daily canônico', () => {
    expect(coerceScheduleConfig({ type: 'DAILY', times: '10:00' })).toEqual({
      type: 'daily',
      times: ['10:00'],
    });
  });

  it('extrai horário de at quando times falta em daily', () => {
    expect(coerceScheduleConfig({ type: 'daily', at: '10:00' })).toEqual({
      type: 'daily',
      times: ['10:00'],
    });
  });

  it('usa reminderTime para Continua sem scheduleConfig', () => {
    expect(
      coerceScheduleConfig(null, {
        reminderTime: '10:00',
        goalType: 'Continua',
      }),
    ).toEqual({ type: 'daily', times: ['10:00'] });
  });

  it('aceita frequency DAILY no objeto de schedule do REST', () => {
    expect(
      coerceScheduleConfig({ frequency: 'DAILY', times: ['10:00'] }),
    ).toEqual({
      type: 'daily',
      times: ['10:00'],
    });
  });
});

describe('resolveDailyStatusForDate', () => {
  const tz = 'America/Sao_Paulo';
  const now = DateTime.fromISO('2026-08-26T15:00:00', { zone: tz });

  const goalWithEvents = {
    dailyStatus: 'DONE',
    plantedTree: {
      growthEvents: [
        { createdAt: '2026-01-01T12:00:00.000Z', progressIndex: 1 },
        { createdAt: '2026-08-25T14:00:00.000-03:00', progressIndex: 2 },
      ],
    },
  };

  it('não propaga DONE do banco para o dia seguinte sem colheita', () => {
    const tomorrow = DateTime.fromISO('2026-08-27', { zone: tz });
    expect(resolveDailyStatusForDate(goalWithEvents, tomorrow, tz, now)).toBe(
      'PENDING',
    );
  });

  it('retorna DONE hoje quando há colheita no dia', () => {
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    const goal = {
      dailyStatus: 'DONE',
      plantedTree: {
        growthEvents: [
          { createdAt: '2026-01-01T12:00:00.000Z', progressIndex: 1 },
          { createdAt: '2026-08-26T14:00:00.000-03:00', progressIndex: 2 },
        ],
      },
    };
    expect(resolveDailyStatusForDate(goal, today, tz, now)).toBe('DONE');
  });

  it('retorna PENDING hoje se DONE no banco for de ontem', () => {
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    expect(
      resolveDailyStatusForDate(
        {
          dailyStatus: 'DONE',
          reminderUpdatedAt: '2026-08-25T20:00:00.000-03:00',
          plantedTree: {
            growthEvents: [
              { createdAt: '2026-01-01T12:00:00.000Z', progressIndex: 1 },
            ],
          },
        },
        today,
        tz,
        now,
      ),
    ).toBe('PENDING');
  });

  it('retorna DONE no passado quando há growthEvent de conclusão no dia', () => {
    const past = DateTime.fromISO('2026-08-25', { zone: tz });
    expect(resolveDailyStatusForDate(goalWithEvents, past, tz, now)).toBe(
      'DONE',
    );
  });

  it('retorna PENDING no passado sem progresso no dia', () => {
    const past = DateTime.fromISO('2026-08-24', { zone: tz });
    expect(resolveDailyStatusForDate(goalWithEvents, past, tz, now)).toBe(
      'PENDING',
    );
  });
});

describe('resolveOccurrenceStatus', () => {
  const tz = 'America/Sao_Paulo';
  const createdAt = '2026-01-01T12:00:00.000Z';

  function goal(overrides: Record<string, unknown> = {}) {
    return {
      createdAt,
      schedule: { type: 'daily' as const, times: ['08:00', '18:00'] },
      plantedTree: { growthEvents: [] as Array<Record<string, unknown>> },
      ...overrides,
    };
  }

  it('hoje com 08:00 e 18:00 às 10:00 segue PENDING', () => {
    const now = DateTime.fromISO('2026-08-26T10:00:00', { zone: tz });
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    expect(resolveOccurrenceStatus(goal(), today, tz, now)).toBe('PENDING');
  });

  it('vira MISSED no instante do último horário e segue PENDING um minuto antes', () => {
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    const before = DateTime.fromISO('2026-08-26T17:59:00', { zone: tz });
    const atLast = DateTime.fromISO('2026-08-26T18:00:00', { zone: tz });
    expect(resolveOccurrenceStatus(goal(), today, tz, before)).toBe('PENDING');
    expect(resolveOccurrenceStatus(goal(), today, tz, atLast)).toBe('MISSED');
  });

  it('um horário 07:00 com DONE de ontem às 10:00 é MISSED', () => {
    const now = DateTime.fromISO('2026-08-26T10:00:00', { zone: tz });
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    expect(
      resolveOccurrenceStatus(
        goal({
          schedule: { type: 'daily', times: ['07:00'] },
          dailyStatus: 'DONE',
          reminderUpdatedAt: '2026-08-25T20:00:00.000-03:00',
          plantedTree: {
            growthEvents: [
              { createdAt, progressIndex: 1 },
              {
                createdAt: '2026-08-25T18:00:00.000-03:00',
                progressIndex: 2,
              },
            ],
          },
        }),
        today,
        tz,
        now,
      ),
    ).toBe('MISSED');
  });

  it('dia futuro com DONE ou SKIPPED vivos segue PENDING', () => {
    const now = DateTime.fromISO('2026-08-26T10:00:00', { zone: tz });
    const tomorrow = DateTime.fromISO('2026-08-27', { zone: tz });
    expect(
      resolveOccurrenceStatus(
        goal({
          dailyStatus: 'DONE',
          reminderUpdatedAt: '2026-08-26T09:00:00.000-03:00',
        }),
        tomorrow,
        tz,
        now,
      ),
    ).toBe('PENDING');
    expect(
      resolveOccurrenceStatus(
        goal({ dailyStatus: 'SKIPPED' }),
        tomorrow,
        tz,
        now,
      ),
    ).toBe('PENDING');
  });

  it('passado com colheita é DONE e passado sem colheita é MISSED', () => {
    const now = DateTime.fromISO('2026-08-26T10:00:00', { zone: tz });
    const harvested = DateTime.fromISO('2026-08-25', { zone: tz });
    const empty = DateTime.fromISO('2026-08-24', { zone: tz });
    expect(
      resolveOccurrenceStatus(
        goal({
          plantedTree: {
            growthEvents: [
              { createdAt, progressIndex: 1 },
              {
                createdAt: '2026-08-25T14:00:00.000-03:00',
                progressIndex: 2,
              },
            ],
          },
        }),
        harvested,
        tz,
        now,
      ),
    ).toBe('DONE');
    expect(resolveOccurrenceStatus(goal(), empty, tz, now)).toBe('MISSED');
  });

  it('hoje com colheita depois do último horário segue DONE', () => {
    const now = DateTime.fromISO('2026-08-26T19:00:00', { zone: tz });
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    expect(
      resolveOccurrenceStatus(
        goal({
          plantedTree: {
            growthEvents: [
              { createdAt, progressIndex: 1 },
              {
                createdAt: '2026-08-26T14:00:00.000-03:00',
                progressIndex: 2,
              },
            ],
          },
        }),
        today,
        tz,
        now,
      ),
    ).toBe('DONE');
  });

  it('SKIPPED de hoje permanece depois do último horário e não pinta amanhã', () => {
    const now = DateTime.fromISO('2026-08-26T19:00:00', { zone: tz });
    const today = DateTime.fromISO('2026-08-26', { zone: tz });
    const tomorrow = DateTime.fromISO('2026-08-27', { zone: tz });
    const skipped = goal({ dailyStatus: 'SKIPPED' });
    expect(resolveOccurrenceStatus(skipped, today, tz, now)).toBe('SKIPPED');
    expect(resolveOccurrenceStatus(skipped, tomorrow, tz, now)).toBe('PENDING');
  });
});
