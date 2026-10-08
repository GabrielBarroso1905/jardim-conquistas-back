import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  HttpStatus,
  Query,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import type { Response } from 'express';
import { parseSVGLayout } from './svg-parser';
import { WorldsConfigService } from './worlds-config.service';
import { WorldsService } from './worlds.service';
import { SupabaseService } from '../../supabase/supabase.service';
import { prisma } from '../../prisma/client';
import { StorageService } from '../../storage/storage.service';
import { normalizeWorldSvgKey } from '../../storage/asset-key.util';

@ApiTags('Mundos — SVG e Scan')
@Controller('api/worlds')
export class WorldsSvgController {
  constructor(
    private readonly configService: WorldsConfigService,
    private readonly worldsService: WorldsService,
    private readonly supabaseService: SupabaseService,
    private readonly storageService: StorageService,
  ) {}

  @Get(':id/svg')
  @ApiOperation({
    summary: 'Obter SVG do mundo',
    description: 'Retorna o arquivo SVG de fundo do mundo especificado.',
  })
  @ApiParam({ name: 'id', description: 'ID do mundo' })
  @ApiResponse({ status: 200, description: 'Arquivo SVG retornado.' })
  @ApiResponse({ status: 404, description: 'Mundo ou SVG não encontrado.' })
  async getSvg(@Param('id') id: string, @Res() res: Response) {
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');
    if (!safeId)
      return res.status(HttpStatus.BAD_REQUEST).send('invalid world id');

    const world = await this.worldsService.getWorldById(safeId);
    if (!world) return res.status(HttpStatus.NOT_FOUND).send('world not found');

    const key = normalizeWorldSvgKey(world.svgPath);
    if (key.startsWith('assets/')) {
      try {
        const object = await this.storageService.getObject(key);
        if (!object.body)
          return res.status(HttpStatus.NOT_FOUND).send('svg file not found');

        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        if (object.contentLength != null) {
          res.setHeader('Content-Length', String(object.contentLength));
        }
        object.body.on('error', () => {
          if (!res.headersSent) {
            res
              .status(HttpStatus.INTERNAL_SERVER_ERROR)
              .send('error reading file');
          }
        });
        object.body.pipe(res);
        return;
      } catch {
        return res
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .send('error reading file');
      }
    }

    const svgPath = join(process.cwd(), world.svgPath);
    if (!existsSync(svgPath))
      return res.status(HttpStatus.NOT_FOUND).send('svg file not found');

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    const stream = createReadStream(svgPath);
    stream.on('error', () =>
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('error reading file'),
    );
    stream.pipe(res);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar mundos',
    description:
      'Retorna os mundos cadastrados. svgUrl é a URL assinada do fundo; svgPath fica só no banco.',
  })
  @ApiResponse({ status: 200, description: 'Lista de mundos.' })
  async getWorlds() {
    const worlds = await this.worldsService.getAllWorlds();
    return Promise.all(
      worlds.map(async (w) => {
        const key = normalizeWorldSvgKey(w.svgPath);
        const svgUrl = key.startsWith('assets/')
          ? await this.storageService.getSignedUrl(key)
          : undefined;
        return {
          worldId: w.worldId,
          name: w.name,
          svgUrl,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        };
      }),
    );
  }

  @Post('scan')
  @ApiOperation({
    summary: 'Escanear mundos do Supabase',
    description:
      'Lista os arquivos de mundos no bucket do Supabase e sincroniza anchors/configs no banco.',
  })
  @ApiQuery({
    name: 'bucket',
    required: false,
    description: 'Nome do bucket no Supabase',
  })
  @ApiQuery({
    name: 'debug',
    required: false,
    description: 'Ativar debug (1 ou true)',
  })
  @ApiResponse({ status: 200, description: 'Resultado do scan.' })
  async scanWorlds(
    @Query('bucket') bucket?: string,
    @Query('debug') debug?: string,
  ) {
    const logger = new Logger('WorldsScan');
    const client = this.supabaseService.getClient();
    const dbg = debug === '1' || debug === 'true';
    const bucketName =
      bucket || process.env.SUPABASE_BUCKET || 'jardim-das-conquistas';

    const basePrefix = 'words/';
    const queue: string[] = [basePrefix];
    const fileExtRegex = /\.(svg|png|jpg|jpeg)$/i;
    const items: Array<{ path: string }> = [];
    const foldersVisited: string[] = [];

    while (queue.length > 0) {
      const prefix = queue.shift() as string;
      foldersVisited.push(prefix);
      logger.log(`Listing prefix: ${prefix}`);
      const listRes = await client.storage
        .from(bucketName)
        .list(prefix, { limit: 1000 });
      if (listRes.error) {
        logger.warn(
          `Error listing prefix '${prefix}': ${listRes.error.message || listRes.error}`,
        );
        continue;
      }
      const data = Array.isArray(listRes.data) ? listRes.data : [];
      if (dbg) logger.log(`Found ${data.length} entries under ${prefix}`);
      for (const it of data) {
        const name = it.name ?? it.id ?? '';
        if (!name) continue;
        if (fileExtRegex.test(name)) {
          const full = `${prefix}${name}`.replace(/\\/g, '/');
          items.push({ path: full });
        } else {
          const nextPrefix = `${prefix}${name}`.replace(/\\/g, '/') + '/';
          queue.push(nextPrefix);
        }
      }
    }

    const worldsMap: Record<
      string,
      { anchors?: string; bg?: string; files: string[] }
    > = {};
    for (const it of items) {
      const rel = it.path.replace(/^words\//, '');
      const segs = rel.split('/').filter(Boolean);
      if (segs.length === 0) continue;
      const worldId = segs[0];
      if (!worldsMap[worldId]) worldsMap[worldId] = { files: [] };
      worldsMap[worldId].files.push(it.path);
      const fname = segs.slice(1).join('/').toLowerCase();
      const baseName = fname.split('/').pop() || fname;
      if (baseName.endsWith('.svg') && baseName.includes('anchors'))
        worldsMap[worldId].anchors = it.path;
      if (
        baseName === 'bg.svg' ||
        baseName.endsWith('/bg.svg') ||
        baseName === 'bg.svg'
      )
        worldsMap[worldId].bg = it.path;
    }

    const scanned: string[] = [];
    const errors: any[] = [];
    for (const worldId of Object.keys(worldsMap)) {
      const info = worldsMap[worldId];
      try {
        if (!info.anchors) {
          logger.warn(
            `No anchors.svg for world ${worldId}, files: ${JSON.stringify(info.files)}`,
          );
          errors.push({ worldId, error: 'anchors_missing', files: info.files });
          continue;
        }
        const anchorsText = await this.supabaseService.getSvgFromStorage(
          bucketName,
          info.anchors,
        );
        const anchorsJson = await parseSVGLayout(anchorsText);

        const name = (this.worldsService as any).deriveName
          ? (this.worldsService as any).deriveName(worldId)
          : worldId;
        const resource = info.bg || info.anchors;
        const svgPath = normalizeWorldSvgKey(resource);
        await prisma.world.upsert({
          where: { worldId },
          update: { name, svgPath, updatedAt: new Date() },
          create: { worldId, name, svgPath },
        });

        await this.configService.upsert(worldId, {
          anchors: anchorsJson as any,
        });

        scanned.push(worldId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed processing world ${worldId}: ${msg}`);
        errors.push({ worldId, error: String(err) });
      }
    }

    const result: any = {
      message: 'Worlds scanned from Supabase',
      scanned,
      errors,
      totalFiles: items.length,
      foldersVisited,
    };
    if (dbg) result.debug = { items: items.slice(0, 200) };
    return result;
  }

  @Post(':id/svg')
  @ApiOperation({
    summary: 'Upload SVG do mundo',
    description: 'Faz upload de um SVG como background para o mundo.',
  })
  @ApiParam({ name: 'id', description: 'ID do mundo' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['svg'],
      properties: {
        svg: { type: 'string', description: 'Conteúdo SVG em texto' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'SVG salvo com sucesso.' })
  async uploadSvg(
    @Param('id') id: string,
    @Body() body: { svg?: string },
    @Res() res: Response,
  ) {
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');
    if (!safeId)
      return res.status(HttpStatus.BAD_REQUEST).send('invalid world id');

    const svg = body?.svg;
    if (!svg || typeof svg !== 'string')
      return res.status(HttpStatus.BAD_REQUEST).send('missing svg in body');

    const maxSize = 2 * 1024 * 1024;
    if (Buffer.byteLength(svg, 'utf8') > maxSize)
      return res.status(HttpStatus.PAYLOAD_TOO_LARGE).send('svg too large');

    const dataDir = join(process.cwd(), 'data', 'worlds');
    const historyDir = join(dataDir, 'history', safeId);
    try {
      require('fs').mkdirSync(dataDir, { recursive: true });
      require('fs').mkdirSync(historyDir, { recursive: true });

      const filePath = join(dataDir, `${safeId}.svg`);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const historyPath = join(historyDir, `${timestamp}.svg`);

      await require('fs').promises.writeFile(filePath, svg, 'utf8');
      await require('fs').promises.writeFile(historyPath, svg, 'utf8');

      return res.status(HttpStatus.CREATED).json({
        ok: true,
        path: filePath,
        history: historyPath,
        savedAt: new Date().toISOString(),
      });
    } catch (err) {
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ ok: false, error: String(err) });
    }
  }

  @Post(':id/anchors-config/regenerate')
  @ApiOperation({
    summary: 'Regenerar config de anchors',
    description:
      'Reprocessa o SVG do mundo e regenera a configuração de anchors.',
  })
  @ApiParam({ name: 'id', description: 'ID do mundo' })
  @ApiResponse({ status: 200, description: 'Config regenerada.' })
  async regenerateAnchorsConfig(@Param('id') id: string, @Res() res: Response) {
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '');
    if (!safeId)
      return res.status(HttpStatus.BAD_REQUEST).send('invalid world id');

    const world = await this.worldsService.getWorldById(safeId);
    if (!world) return res.status(HttpStatus.NOT_FOUND).send('world not found');

    try {
      const svgText = await this.worldsService.readSvgText(world.svgPath);
      if (svgText == null)
        return res.status(HttpStatus.NOT_FOUND).send('svg file not found');

      const json = await parseSVGLayout(svgText);
      await this.configService.upsert(safeId, { anchors: json as any });
      return res.status(HttpStatus.OK).json({
        ...json,
        meta: {
          source: 'regenerated',
          generatedAt: new Date().toISOString(),
          includeIds: true,
        },
      });
    } catch (err) {
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ ok: false, error: String(err) });
    }
  }
}

export default WorldsSvgController;
