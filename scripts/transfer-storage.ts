/**
 * Copia objetos do bucket S3/Garage (S3_*) para o Storage do Supabase.
 *
 * Requer SUPABASE_SERVICE_ROLE_KEY (upload não funciona com chave publishable).
 *
 * Uso:
 *   npm run storage:transfer:dry-run
 *   npm run storage:transfer
 *   npm run storage:transfer -- --prefix assets/
 *   npm run storage:transfer -- --skip-existing
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function normalizeSupabaseUrl(url: string): string {
  const t = url.trim();
  if (!t) return t;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  return `https://${t}`;
}

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

function contentTypeForKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* listS3Keys(
  client: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<string> {
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      }),
    );
    for (const item of res.Contents ?? []) {
      if (item.Key && !item.Key.endsWith('/')) yield item.Key;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function ensureBucket(
  supabase: SupabaseClient,
  bucket: string,
): Promise<void> {
  const { data: buckets, error: listError } =
    await supabase.storage.listBuckets();
  if (listError) {
    throw new Error(`listBuckets: ${listError.message}`);
  }
  if (buckets?.some((b) => b.name === bucket)) return;

  const { error: createError } = await supabase.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: 52_428_800, // 50 MiB
  });
  if (createError) {
    throw new Error(
      `Bucket "${bucket}" não existe e não foi possível criar: ${createError.message}. Crie no painel Storage (público).`,
    );
  }
  console.log(`Bucket criado: ${bucket} (público)`);
}

async function supabaseHasObject(
  supabase: SupabaseClient,
  bucket: string,
  key: string,
): Promise<boolean> {
  const dir = key.includes('/') ? key.replace(/\/[^/]+$/, '') : '';
  const name = key.includes('/') ? key.split('/').pop()! : key;
  const { data, error } = await supabase.storage.from(bucket).list(dir, {
    limit: 1000,
    search: name,
  });
  if (error) return false;
  return (data ?? []).some((row) => row.name === name);
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

async function main() {
  loadDotenv();
  const { prefix, skipExisting, dryRun, concurrency } = parseArgs(
    process.argv.slice(2),
  );

  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET || 'jardim-das-conquistas';
  const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL || '');
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  const destBucket =
    process.env.SUPABASE_STORAGE_BUCKET ||
    process.env.SUPABASE_BUCKET ||
    s3Bucket;

  if (!s3Endpoint || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    console.error('Defina S3_ENDPOINT, S3_ACCESS_KEY e S3_SECRET_KEY no .env');
    process.exit(1);
  }
  if (!dryRun && (!supabaseUrl || !supabaseKey)) {
    console.error(
      'Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env (não use a chave publishable).',
    );
    process.exit(1);
  }

  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: process.env.S3_REGION || 'garage',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  const supabase =
    supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  const keys: string[] = [];
  for await (const key of listS3Keys(s3, s3Bucket, prefix)) {
    keys.push(key);
  }

  console.log(
    `Origem: S3 ${s3Bucket} @ ${s3Endpoint} | destino: Supabase bucket "${destBucket}" | objetos: ${keys.length} | prefix: "${prefix || '(todos)'}"`,
  );

  if (dryRun) {
    console.log('[dry-run] nenhum upload; amostra:', keys.slice(0, 15).join(', '));
    if (!supabaseKey) {
      console.log(
        '[dry-run] Para upload real, adicione SUPABASE_SERVICE_ROLE_KEY ao .env.',
      );
    }
    return;
  }

  if (!supabase) {
    console.error('Cliente Supabase não configurado.');
    process.exit(1);
  }
  const supabaseClient = supabase;

  await ensureBucket(supabaseClient, destBucket);

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
          const exists = await supabaseHasObject(supabaseClient, destBucket, key);
          if (exists) {
            skipped += 1;
            continue;
          }
        }

        const obj = await s3.send(
          new GetObjectCommand({ Bucket: s3Bucket, Key: key }),
        );
        const body = await streamToBuffer(obj.Body);
        if (body.length === 0) {
          skipped += 1;
          continue;
        }

        const contentType =
          obj.ContentType || contentTypeForKey(key) || 'application/octet-stream';

        const { error } = await supabaseClient.storage.from(destBucket).upload(key, body, {
          upsert: true,
          contentType,
          cacheControl: '3600',
        });

        if (error) throw error;
        uploaded += 1;
        if (uploaded % 25 === 0) {
          console.log(`progresso: ${uploaded}/${keys.length} enviados...`);
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