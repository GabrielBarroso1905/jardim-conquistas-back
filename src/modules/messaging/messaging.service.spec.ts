import { MessagingService } from './messaging.service';
import { ReminderDeliveryService } from '../reminder/delivery/reminder-delivery.service';
import { REMINDER_KINDS } from '../reminder/reminder.types';

describe('MessagingService.sendToUser', () => {
  const user = {
    id: 'u1',
    whatsappId: '5511999999999',
    telegramId: null,
    preferredChannel: 'WHATSAPP',
  };

  it('trata null do WhatsApp como dedupe (envio OK)', async () => {
    const whatsapp = {
      sendReply: jest.fn().mockResolvedValue(null),
    };
    const telegram = { sendReply: jest.fn() };
    const service = new MessagingService(telegram as any, whatsapp as any);

    const ok = await service.sendToUser(user, 'lembrete', 'reminder');
    expect(ok).toBe(true);
    expect(whatsapp.sendReply).toHaveBeenCalled();
  });

  it('trata undefined do WhatsApp como falha (não marca como enviado)', async () => {
    const whatsapp = {
      sendReply: jest.fn().mockResolvedValue(undefined),
    };
    const telegram = { sendReply: jest.fn().mockResolvedValue(undefined) };
    const service = new MessagingService(telegram as any, whatsapp as any);

    const ok = await service.sendToUser(user, 'lembrete', 'reminder');
    expect(ok).toBe(false);
  });

  it('ReminderDelivery não considera sucesso quando messaging retorna false', async () => {
    const messaging = {
      hasAnyChannel: jest.fn().mockReturnValue(true),
      sendToUser: jest.fn().mockResolvedValue(false),
    };
    const observability = { delivery: jest.fn() };
    const delivery = new ReminderDeliveryService(
      messaging as any,
      observability as any,
    );

    const ok = await delivery.send({
      user: { whatsappId: '5511' },
      text: 'hora de tomar remédio',
      kind: REMINDER_KINDS.OPERATIONAL,
      goalId: 'g1',
      userId: 'u1',
    });

    expect(ok).toBe(false);
    expect(observability.delivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', reason: 'missing_channel' }),
    );
  });
});
