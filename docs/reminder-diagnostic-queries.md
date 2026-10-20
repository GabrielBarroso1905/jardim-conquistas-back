# Diagnóstico de lembretes (SQL / Prisma)

Use após um lembrete que não chegou no WhatsApp/Telegram para ver se a meta foi criada, se o horário no banco está correto e se o dispatch já tentou enviar.

## SQL (PostgreSQL)

Por título recente (ajuste o título):

```sql
SELECT
  g.id AS goal_id,
  g.title,
  g."goalKind",
  g.completed,
  g."createdAt",
  gs.frequency,
  gs.at AS schedule_at_utc,
  gs."timeZone" AS schedule_tz,
  gr."dailyStatus",
  gr."lastSentAt",
  gr."sentCount",
  gr."slotsToday",
  gr."silenceUntil",
  u.email,
  u.timezone AS user_timezone,
  u."whatsappId",
  u."preferredChannel"
FROM "Goal" g
LEFT JOIN "GoalSchedule" gs ON gs."goalId" = g.id
LEFT JOIN "GoalReminder" gr ON gr."goalId" = g.id
LEFT JOIN "User" u ON u.id = g."userId"
WHERE g.title ILIKE '%tomar rem%'
ORDER BY g."createdAt" DESC
LIMIT 5;
```

Interpretação rápida:

| `lastSentAt` | `dailyStatus` | Leitura provável |
|--------------|---------------|------------------|
| `NULL` após o horário | qualquer | Política em `wait`, claim falhou ou exceção antes do envio |
| preenchido | `WAITING_OPERATIONAL_REPLY` | Sistema considera que enviou; se o usuário não viu, checar WhatsApp/Evolution ou dedupe |
| preenchido | outro | Investigar `slotsToday` e rollback |

Converter `schedule_at_utc` para o fuso do usuário (ex. Fortaleza): use o script `npm run diagnose:reminder -- --goalId=<uuid>`.

## Prisma (mesma consulta)

```ts
const goals = await prisma.goal.findMany({
  where: { title: { contains: 'Tomar rem', mode: 'insensitive' } },
  orderBy: { createdAt: 'desc' },
  take: 5,
  include: {
    schedule: true,
    reminder: true,
    user: {
      select: {
        email: true,
        timezone: true,
        whatsappId: true,
        preferredChannel: true,
      },
    },
  },
});
```

## Script CLI

```bash
npm run diagnose:reminder -- --goalId=<uuid>
npm run diagnose:reminder -- --userId=<uuid>
npm run diagnose:reminder -- --title="Tomar remédio"
```

Com `LOG_REMINDERS=1` no `.env`, o cron também registra decisões de envio e falhas de claim no console.
