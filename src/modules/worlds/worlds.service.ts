import { Injectable } from '@nestjs/common';
import { prisma } from '../../prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import { parseSVGLayout } from './svg-parser';
import { WorldsConfigService } from './worlds-config.service';
import { StorageService } from '../../storage/storage.service';
import { normalizeWorldSvgKey } from '../../storage/asset-key.util';

async function readableToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

@Injectable()
export class WorldsService {
  constructor(
    private readonly configService: WorldsConfigService,
    private readonly storageService: StorageService,
  ) {}

  private worldsPath = path.join(
    process.cwd(),
    'src',
    'assets',
    'worlds',
    'ancoras',
  );

  async scanAndPopulateWorlds() {
    const svgFiles: string[] = [];
    this.scanDirectory(this.worldsPath, svgFiles);

    for (const svgFile of svgFiles) {
      const relativePath = path.relative(
        path.join(process.cwd(), 'src', 'assets', 'worlds'),
        svgFile,
      );
      const worldId = path.parse(svgFile).name; // e.g., 'mundo2' from 'mundo2.svg'
      const svgPath = path
        .join('src', 'assets', 'worlds', relativePath)
        .replace(/\\/g, '/'); // normalize to /
      const name = this.deriveName(worldId);

      await prisma.world.upsert({
        where: { worldId },
        update: { name, svgPath, updatedAt: new Date() },
        create: { worldId, name, svgPath },
      });

      // Parse SVG for anchors and update config
      try {
        const svgText = fs.readFileSync(svgFile, 'utf8');
        const anchors = await parseSVGLayout(svgText);
        await this.configService.upsert(worldId, { anchors: anchors as any });
      } catch (err) {
        console.error(`Failed to parse SVG for ${worldId}:`, err);
      }
    }
  }

  private scanDirectory(dir: string, svgFiles: string[]) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        this.scanDirectory(fullPath, svgFiles);
      } else if (file.endsWith('.svg')) {
        svgFiles.push(fullPath);
      }
    }
  }

  private deriveName(worldId: string): string {
    // Simple derivation, can be improved
    return worldId
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (str) => str.toUpperCase());
  }

  async getAllWorlds() {
    return prisma.world.findMany({
      include: { config: true },
      orderBy: { name: 'asc' },
    });
  }

  async getWorldById(worldId: string) {
    return prisma.world.findUnique({
      where: { worldId },
      include: { config: true },
    });
  }

  async getDefaultWorld() {
    // For now, return the first world or 'mundo2' if exists
    const worlds = await this.getAllWorlds();
    return worlds.find((w) => w.worldId === 'mundo2') || worlds[0];
  }

  async readSvgText(storedPath: string): Promise<string | null> {
    const key = normalizeWorldSvgKey(storedPath);
    if (key.startsWith('assets/')) {
      const object = await this.storageService.getObject(key);
      if (!object.body) return null;
      return readableToString(object.body);
    }

    const svgPath = path.join(process.cwd(), storedPath);
    if (!fs.existsSync(svgPath)) return null;
    return fs.readFileSync(svgPath, 'utf8');
  }

  async regenerateConfig(worldId: string) {
    const world = await this.getWorldById(worldId);
    if (!world) throw new Error('World not found');

    const svgText = await this.readSvgText(world.svgPath);
    if (svgText == null) throw new Error('SVG file not found');

    const anchors = await parseSVGLayout(svgText);
    await this.configService.upsert(worldId, { anchors: anchors as any });
    return { message: 'Config regenerated' };
  }
}
