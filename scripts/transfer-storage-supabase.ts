/**
 * Copia objetos entre dois projetos Supabase Storage (ex.: main → production).
 *
 * Destino: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY do .env atual.
 * Origem: arquivo STORAGE_TRANSFER_SOURCE_ENV (default .env_main) ou SUPABASE_SOURCE_*.
 *
 * Uso:
 *   npm run storage:transfer:supabase:dry-run
 *   npm run storage:transfer:supabase
 *   npm run storage:transfer:supabase -- --prefix assets/
 *   npm run storage:transfer:supabase -- --skip-existing
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseEnvFileContent } from '../src/config/storage-env-overlay';

function loadDotenv(): void {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizeSupabaseUrl(url: string): string {
  const t = url.trim();
  if (!t) return t;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  return `https://${t}`;
}

function loadSourceFromEnvFile(): Record<string, string> {
  const relative =
    process.env.STORAGE_TRANSFER_SOURCE_ENV?.trim() || '.env_main';
  const filePath = resolve(process.cwd(), relative);
  if (!existsSync(filePath)) {
    throw new Error(`Arquivo de origem não encontrado: ${filePath}`);
  }
  return parseEnvFileContent(readFileSync(filePath, 'utf8'));
}

function contentTypeForKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}

async function* listAllObjectKeys(
  client: SupabaseClient,
  bucket: string,
  prefix = '',
): AsyncGenerator<string> {
  const { data, error } = await client.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw new Error(`list(${prefix || '/'}): ${error.message}`);

  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    const isFile = item.metadata != null && typeof item.metadata === 'object';
    if (isFile) {
      yield path;
    } else {
      yield* listAllObjectKeys(client, bucket, path);
    }
  }
}

function parseArgs(argv: string[]) {
  let prefix = process.env.STORAGE_TRANSFER_PREFIX || '';
  let skipExisting = false;
  let dryRun = false;
  let concurrency = Number(process.env.STORAGE_TRANSFER_CONCURRENCY || 5);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--skip-existing') skipExisting = true;
    else if (a === '--prefix') prefix = argv[++i] ?? '';
    else if (a === '--concurrency') concurrency = Number(argv[++i] || 5);
  }
  return { prefix, skipExisting, dryRun, concurrency: Math.max(1, concurrency) };
}

async function destHasObject(
  client: SupabaseClient,
  bucket: string,
  key: string,
): Promise<boolean> {
  const { data, error } = await client.storage.from(bucket).download(key);
  if (!error && data) return true;
  return false;
}

async function main() {
  loadDotenv();
  const { prefix, skipExisting, dryRun, concurrency } = parseArgs(
    process.argv.slice(2),
  );

  const sourceFile = loadSourceFromEnvFile();
  const srcUrl = normalizeSupabaseUrl(
    process.env.SUPABASE_SOURCE_URL ||
      sourceFile.SUPABASE_URL ||
      '',
  );
  const srcKey =
    process.env.SUPABASE_SOURCE_SERVICE_ROLE_KEY ||
    sourceFile.SUPABASE_SERVICE_ROLE_KEY ||
    sourceFile.SUPABASE_SERVICE_KEY ||
    '';
  const srcBucket =
    process.env.SUPABASE_SOURCE_STORAGE_BUCKET ||
    sourceFile.SUPABASE_STORAGE_BUCKET ||
  sourceFile.SUPABASE_BUCKET ||
    'jardim-das-conquistas';

  const dstUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
  const dstKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  const dstBucket =
    process.env.SUPABASE_STORAGE_BUCKET ||
    process.env.SUPABASE_BUCKET ||
    srcBucket;

  if (!srcUrl || !srcKey) {
    console.error('Origem: defina SUPABASE_URL + SERVICE_ROLE no .env_main ou SUPABASE_SOURCE_*');
    process.exit(1);
  }
  if (!dstUrl || !dstKey) {
    console.error('Destino: defina SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY no .env (production)');
    process.exit(1);
  }
  if (srcUrl === dstUrl && srcBucket === dstBucket) {
    console.error('Origem e destino são o mesmo Supabase/bucket.');
    process.exit(1);
  }

  const source = createClient(srcUrl, srcKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const dest = createClient(dstUrl, dstKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const listRoot = prefix ? prefix.replace(/\/+$/, '') : '';
  const keys: string[] = [];
  for await (const key of listAllObjectKeys(source, srcBucket, listRoot)) {
    keys.push(key);
  }

  console.log(
    `Origem: ${srcUrl} bucket "${srcBucket}" → destino: ${dstUrl} bucket "${dstBucket}" | objetos: ${keys.length} | prefix: "${prefix || '(todos)'}"`,
  );

  if (dryRun) {
    console.log('[dry-run] amostra:', keys.slice(0, 20).join(', '));
    return;
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < keys.length) {
      const i = index++;
      const key = keys[i]!;
      try {
        if (skipExisting) {
          const exists = await destHasObject(dest, dstBucket, key);
          if (exists) {
            skipped += 1;
            continue;
          }
        }

        const { data, error: dlErr } = await source.storage
          .from(srcBucket)
          .download(key);
        if (dlErr || !data) {
          throw new Error(dlErr?.message || 'download vazio');
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        const contentType = data.type || contentTypeForKey(key) || 'application/octet-stream';

        const { error: upErr } = await dest.storage.from(dstBucket).upload(key, buffer, {
          upsert: true,
          contentType,
          cacheControl: '3600',
        });
        if (upErr) throw upErr;

        uploaded += 1;
        if (uploaded % 25 === 0) {
          console.log(`progresso: ${uploaded}/${keys.length}...`);
        }
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`falha ${key}: ${msg}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(
    `Concluído: uploaded=${uploaded}, skipped=${skipped}, failed=${failed}, total=${keys.length}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});