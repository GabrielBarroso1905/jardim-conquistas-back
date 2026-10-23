import { Injectable, Logger } from '@nestjs/common';
import { REMINDER_POLICY_ACTIONS } from '../reminder.types';

function remindersVerbose(): boolean {
  return process.env.LOG_REMINDERS === '1';
}

@Injectable()
export class ReminderObservabilityService {
  private readonly logger = new Logger(ReminderObservabilityService.name);

  policy(event: Record<string, unknown>) {
    const action = event.action;
    const notable =
      remindersVerbose() ||
      action !== REMINDER_POLICY_ACTIONS.WAIT;
    if (notable) {
      this.logger.log(`reminder_policy ${JSON.stringify(event)}`);
    } else {
      this.logger.debug(`reminder_policy ${JSON.stringify(event)}`);
    }
  }

  delivery(event: Record<string, unknown>) {
    const status = event.status;
    const notable =
      remindersVerbose() || status === 'skipped' || status === 'sent';
    if (notable) {
      const line = `reminder_delivery ${JSON.stringify(event)}`;
      if (status === 'skipped') this.logger.warn(line);
      else this.logger.log(line);
    } else {
      this.logger.debug(`reminder_delivery ${JSON.stringify(event)}`);
    }
  }

  reply(event: Record<string, unknown>) {
    if (remindersVerbose()) {
      this.logger.log(`reminder_reply ${JSON.stringify(event)}`);
    } else {
      this.logger.debug(`reminder_reply ${JSON.stringify(event)}`);
    }
  }
}
