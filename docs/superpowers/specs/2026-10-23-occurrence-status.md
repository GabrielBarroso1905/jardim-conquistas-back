# Status da ocorrência na timeline

A timeline (dia, semana e mês) mostra uma ocorrência por meta por dia civil. O status dessa linha é `PENDING`, `DONE`, `MISSED` ou `SKIPPED`.

O cálculo é `resolveOccurrenceStatus` em `src/modules/shared/schedule-occurrence.util.ts`. Dia, semana e mês usam essa função. Não há uma segunda regra no dashboard.

`resolveDailyStatusForDate` continua só com a conclusão do dia civil e o status vivo do lembrete. Passado sem colheita segue `PENDING` nesse helper. Quem decide `MISSED` é `resolveOccurrenceStatus`.

O `MISSED` do lembrete (last-chance sem resposta) é outro conceito. Está no contrato de 2026-09-04 e não pinta a timeline.

## Forma da linha

- Uma linha por meta no dia.
- Vários horários ficam em `schedule.times` e entram em `expectedSlots`.
- `startTime` é o primeiro horário. `instanceId` é `{goalId}:{YYYY-MM-DD}:{startTime}`.
- `endTime` é `startTime` mais 30 minutos e só serve para exibir. Não atrasa o `MISSED`.
- `harvestSummary.collected` conta linhas `DONE`.
- `harvestSummary.total` conta linhas da timeline no dia (uma por meta), não a soma de horários.

## Indicadores de progresso

Unidade de contabilização para percentuais e resumos: **ocorrência da timeline** (uma por meta por dia civil em que a meta tem agenda). Horários agendados são métrica separada.

| Campo | Significado |
|-------|-------------|
| `harvestSummary.collected` / `weeklyProgress.harvested` / `monthlyGoal.harvested` | Ocorrências com `status === 'DONE'` no período |
| `harvestSummary.total` / `weeklyProgress.total` / `monthlyGoal.total` | Quantidade de ocorrências no período (soma de `occurrences.length` por célula na semana/mês) |
| `weekGrid[].harvestCount` / `monthGrid[].harvestCount` | Ocorrências `DONE` naquele dia civil |
| `weekGrid[].expectedSlots` / `monthGrid[].expectedSlots` | Horários agendados no dia (`expectedSlotCountForGoalOnDate`); **não** entra no denominador do progresso |

Exemplo: meta `daily` com `times: ['08:00', '18:00']` em um dia → `expectedSlots = 2`, `harvestSummary.total = 1`. Na semana com essa meta todos os dias → `weeklyProgress.total = 7`, não 14.

O percentual (`weeklyProgress.percentage`, `monthlyGoal.percentage`) usa `min(harvested, total) / total`.

`monthHighlights` ranqueia **eventos de crescimento** por meta no mês; não é a mesma métrica que dias concluídos na timeline.

Implementação: `harvestSummaryFromOccurrences` em `src/modules/dashboard/dashboard.service.ts`.

## Ordem

Tudo no fuso do usuário.

1. **DONE** se houve colheita naquele dia civil (growth event depois do plantio `progressIndex = 1`) ou se o `dailyStatus` `DONE` foi gravado nesse mesmo dia. Uma colheita fecha o dia inteiro, mesmo com dois horários.
2. **SKIPPED** se o dia consultado é hoje e o status vivo do lembrete é `SKIPPED`. Continua `SKIPPED` depois do último horário. Não passa para ontem nem para amanhã: skip não tem histórico por dia. Um dia passado sem colheita aparece como `MISSED`, mesmo que o status vivo de hoje seja `SKIPPED`.
3. **PENDING** se o dia civil ainda é futuro. Horário futuro não vira `MISSED` antes da hora.
4. **MISSED** quando `now` já alcançou o último horário daquele dia (`now >=` o instante do último `HH:mm`, sem folga). Com `08:00` e `18:00`, às 10:00 o dia segue `PENDING`. Às 18:00 vira `MISSED`. O último horário é o mais tarde do dia, não o último item da lista.
5. **PENDING** no resto: hoje, ainda há horário pela frente, sem `DONE` e sem `SKIPPED`.

`SNOOZED`, `DISMISSED`, `WAITING_*` e o `MISSED` do lembrete não mudam essa ordem. Só `DONE` e `SKIPPED` furam o relógio.

Meta `once` usa o horário de `at`. Sem lista de horários, o limite é `08:00`, o mesmo fallback da exibição.
