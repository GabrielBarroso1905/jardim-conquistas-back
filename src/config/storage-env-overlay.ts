import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/** Env vars the overlay may set (storage only; never DATABASE_URL, JWT, etc.). */
export const STORAGE_OVERLAY_KEYS = [
  'STORAGE_PROVIDER',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'SUPABASE_BUCKET',
  'ASSETS_PUBLIC_BASE_URL',
] as const;

export type StorageOverlayKey = (typeof STORAGE_OVERLAY_KEYS)[number];

export type ParsedEnvFile = Record<string, string>;

export function parseEnvFileContent(content: string): ParsedEnvFile {
  const out: ParsedEnvFile = {};
  for (const line of content.split(/\r?\n/)) {
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
    if (key) out[key] = value;
  }
  return out;
}

export function applyParsedOverlay(
  parsed: ParsedEnvFile,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];

  for (const key of STORAGE_OVERLAY_KEYS) {
    const value = parsed[key];
    if (value != null && String(value).trim() !== '') {
      env[key] = value;
      applied.push(key);
    }
  }

  const overlayPublic = parsed.PUBLIC_BASE_URL?.trim();
  if (overlayPublic && !parsed.ASSETS_PUBLIC_BASE_URL?.trim()) {
    env.ASSETS_PUBLIC_BASE_URL = overlayPublic;
    applied.push('ASSETS_PUBLIC_BASE_URL(from PUBLIC_BASE_URL)');
  }

  return applied;
}

/**
 * Loads STORAGE_ENV_OVERLAY (e.g. `.env_main`) after `.env` and overrides
 * only Supabase/storage-related variables for asset reads and proxy URLs.
 */
export function applyStorageEnvOverlay(
  env: NodeJS.ProcessEnv = process.env,
): { applied: string[]; file?: string } {
  const relative = (env.STORAGE_ENV_OVERLAY ?? '').trim();
  if (!relative) return { applied: [] };

  const filePath = resolve(process.cwd(), relative);
  if (!existsSync(filePath)) {
    console.warn(
      `[storage-env-overlay] STORAGE_ENV_OVERLAY=${relative} not found at ${filePath}`,
    );
    return { applied: [], file: filePath };
  }

  const parsed = parseEnvFileContent(readFileSync(filePath, 'utf8'));
  const applied = applyParsedOverlay(parsed, env);
  if (applied.length > 0) {
    console.log(
      `[storage-env-overlay] Applied ${applied.join(', ')} from ${relative}`,
    );
  }
  return { applied, file: filePath };
}