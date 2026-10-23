import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DashboardDayOccurrenceDto } from './dashboard-day.response';

export class DashboardMonthDayDto {
  @ApiProperty({ description: 'Data do dia (ISO)', example: '2026-10-16' })
  date: string | null;

  @ApiProperty({
    description:
      'Horários agendados no dia; não entra no percentual de monthlyGoal.',
    example: 2,
  })
  expectedSlots: number;

  @ApiProperty({
    description: 'Ocorrências DONE na timeline naquele dia.',
    example: 1,
  })
  harvestCount: number;

  @ApiProperty({
    type: [DashboardDayOccurrenceDto],
    description:
      'Mesmo item do Dia: 1 occurrence por meta (primeiro times), instanceId da célula.',
  })
  occurrences: DashboardDayOccurrenceDto[];
}

export class DashboardMonthProgressDto {
  @ApiProperty({
    example: 13,
    description: 'min(harvested, total) / total no mês, em percentual.',
  })
  percentage: number;

  @ApiProperty({
    example: 31,
    description: 'Total de ocorrências da timeline no mês (não slots).',
  })
  total: number;

  @ApiProperty({
    example: 4,
    description: 'Ocorrências com status DONE no mês.',
  })
  harvested: number;
}

export class DashboardMonthHighlightDto {
  @ApiProperty({ format: 'uuid' })
  goalId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    description:
      'Eventos de crescimento no mês (métrica distinta de dias DONE na timeline).',
  })
  harvestCount: number;
}

export class DashboardMonthResponseDto {
  @ApiProperty({ example: '2026-10' })
  month: string | null;

  @ApiPropertyOptional({ example: 'Corpo', nullable: true })
  areaId: string | null;

  @ApiProperty({ example: '2026-10-01', nullable: true })
  monthStart: string | null;

  @ApiProperty({ example: '2026-10-31', nullable: true })
  monthEnd: string | null;

  @ApiProperty({ type: [DashboardMonthDayDto] })
  monthGrid: DashboardMonthDayDto[];

  @ApiProperty({ type: DashboardMonthProgressDto })
  monthlyGoal: DashboardMonthProgressDto;

  @ApiProperty({ example: 2 })
  activeDays: number;

  @ApiProperty({ type: [DashboardMonthHighlightDto] })
  monthHighlights: DashboardMonthHighlightDto[];
}
