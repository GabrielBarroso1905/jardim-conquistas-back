import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DashboardDayOccurrenceDto {
  @ApiProperty({
    description: '{goalId}:{date}:{startTime} — chave da linha da timeline',
    example: '70df550e-9b35-4e4f-8de4-cdf1692d698b:2026-10-15:08:00',
  })
  instanceId: string;

  @ApiProperty({ format: 'uuid' })
  goalId: string;

  @ApiProperty({ example: 'Beber água' })
  title: string;

  @ApiProperty({ example: 'Continua', enum: ['Continua', 'Pontual'] })
  goalKind: string;

  @ApiProperty({ example: 'Corpo' })
  conquestType: string;

  @ApiPropertyOptional({
    description: 'Agenda canônica da meta (times lista todos os horários)',
    nullable: true,
  })
  schedule: Record<string, unknown> | null;

  @ApiProperty({ example: '08:00' })
  startTime: string;
  

  @ApiProperty({ example: '08:30', description: 'startTime + 30min' })
  endTime: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'DONE', 'MISSED', 'SKIPPED'],
  })
  status: 'PENDING' | 'DONE' | 'MISSED' | 'SKIPPED';

  @ApiProperty({ example: 'fitness_center' })
  icon: string;

  @ApiProperty({
    example: 'garden-green',
    enum: ['garden-green', 'accent-sky', 'accent-pink', 'accent-autumn'],
  })
  accentColor: 'garden-green' | 'accent-sky' | 'accent-pink' | 'accent-autumn';
}

export class DashboardDayHarvestSummaryDto {
  @ApiProperty({ example: 1 })
  collected: number;

  @ApiProperty({ example: 2 })
  total: number;
}

export class DashboardDayResponseDto {
  @ApiProperty({ example: '2026-10-15' })
  date: string;

  @ApiProperty({ type: [DashboardDayOccurrenceDto] })
  occurrences: DashboardDayOccurrenceDto[];

  @ApiProperty({ type: DashboardDayHarvestSummaryDto })
  harvestSummary: DashboardDayHarvestSummaryDto;
}
