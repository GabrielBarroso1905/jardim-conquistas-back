/**
 * Migration: converte World.svgPath de ponteiros Supabase
 * (supabase://bucket/words/{mundo}/bg.svg) e de words/... para keys
 * do Garage (assets/words/{mundo}/bg.svg).
 *
 * Uso: npm run migrate:world-svg-keys
 */

import { prisma } from '../src/prisma/client';
import { normalizeWorldSvgKey } from '../src/storage/asset-key.util';

async function main() {
  const worlds = await prisma.world.findMany();
  let updated = 0;

  for (const world of worlds) {
    const next = normalizeWorldSvgKey(world.svgPath);
    if (!next || next === world.svgPath) continue;

    await prisma.world.update({
      where: { id: world.id },
      data: { svgPath: next },
    });
    updated += 1;
    console.log(`${world.worldId}: ${world.svgPath} -> ${next}`);
  }

  console.log(`done: ${updated} worlds updated`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
