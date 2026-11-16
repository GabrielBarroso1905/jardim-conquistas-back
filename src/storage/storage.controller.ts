import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import { StorageService } from './storage.service';

@ApiTags('Assets')
@Controller('api/assets')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get('*path')
  @ApiOperation({
    summary: 'Proxy de asset (Supabase Storage ou S3)',
    description:
      'Serve objetos do bucket (Storage privado Supabase ou S3/Garage) same-origin, evitando CORS no Pixi. ' +
      'Ativado quando S3_ASSET_PROXY=true; URLs retornadas pela API apontam para este endpoint.',
  })
  @ApiParam({
    name: 'path',
    description: 'Chave do objeto, ex: assets/pontual/stars/a/1.png',
  })
  @ApiResponse({ status: 200, description: 'Arquivo retornado.' })
  @ApiResponse({ status: 404, description: 'Objeto não encontrado.' })
  async getAsset(
    @Param('path') path: string | string[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const rawPath = Array.isArray(path) ? path.join('/') : path;
    const key = decodeURIComponent(rawPath || '').replace(/^\/+/, '');
    if (!key.startsWith('assets/')) {
      throw new NotFoundException('invalid asset key');
    }

    const object = await this.storageService.getObject(key);
    if (!object.body) {
      throw new NotFoundException('asset not found');
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader(
      'Content-Type',
      object.contentType || this.guessContentType(key),
    );
    if (object.contentLength != null) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

    return new StreamableFile(object.body);
  }

  private guessContentType(key: string): string {
    if (key.endsWith('.svg')) return 'image/svg+xml';
    if (key.endsWith('.png')) return 'image/png';
    if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
    if (key.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
  }
}
