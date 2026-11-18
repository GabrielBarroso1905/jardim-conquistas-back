import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { Readable } from 'stream';

describe('StorageController', () => {
  const mockGetObject = jest.fn();
  const controller = new StorageController({
    getObject: mockGetObject,
  } as unknown as StorageService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('faz stream de PNG via proxy same-origin', async () => {
    const body = Readable.from(Buffer.from('fake-png'));
    mockGetObject.mockResolvedValue({
      body,
      contentType: 'image/png',
      contentLength: 8,
    });

    const res = {
      setHeader: jest.fn(),
    };
    const req = { headers: { origin: 'http://localhost:5173' } };

    const file = await controller.getAsset(
      'assets/pontual/stars/a/1.png',
      req as any,
      res as any,
    );

    expect(mockGetObject).toHaveBeenCalledWith('assets/pontual/stars/a/1.png');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'http://localhost:5173',
    );
    expect(file).toBeDefined();
  });

  it('rejeita keys fora de assets/', async () => {
    await expect(
      controller.getAsset(
        'other/file.png',
        { headers: {} } as any,
        { setHeader: jest.fn() } as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('devolve 404 quando o objeto não existe', async () => {
    mockGetObject.mockResolvedValue({ body: null });
    await expect(
      controller.getAsset(
        'assets/words/lago/Lago.svg',
        { headers: {} } as any,
        { setHeader: jest.fn() } as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('devolve 502 quando o storage falha', async () => {
    mockGetObject.mockRejectedValue(new Error('boom'));
    await expect(
      controller.getAsset(
        'assets/words/lago/Lago.svg',
        { headers: {} } as any,
        { setHeader: jest.fn() } as any,
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
