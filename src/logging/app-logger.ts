import { LoggerService } from '@nestjs/common';

const LOG_CONTEXTS = new Set([
  'WhatsAppService',
  'WuzapiClient',
  'NestApplication',
  'ReminderObservabilityService',
]);

const REMINDER_VERBOSE_CONTEXTS = new Set(['ReminderService']);

const ALWAYS_WARN_CONTEXTS = new Set(['ReminderService']);

function isAllowed(context?: string): boolean {
  if (!context) return false;
  if (LOG_CONTEXTS.has(context)) return true;
  if (
    process.env.LOG_REMINDERS === '1' &&
    REMINDER_VERBOSE_CONTEXTS.has(context)
  ) {
    return true;
  }
  return false;
}

function isWarnAllowed(context?: string): boolean {
  if (!context) return false;
  if (ALWAYS_WARN_CONTEXTS.has(context)) return true;
  return isAllowed(context);
}

function stringify(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export class AppLogger implements LoggerService {
  log(message: unknown, context?: string) {
    if (!isAllowed(context)) return;
    console.log(`[${context}] ${stringify(message)}`);
  }

  warn(message: unknown, context?: string) {
    if (!isWarnAllowed(context)) return;
    console.warn(`[${context}] ${stringify(message)}`);
  }

  error(message: unknown, trace?: string, context?: string) {
    console.error(`[${context ?? 'App'}] ${stringify(message)}`);
    if (trace) console.error(trace);
  }

  debug() {}
  verbose() {}
}
