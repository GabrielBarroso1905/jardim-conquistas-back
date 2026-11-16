export type StorageProvider = 'supabase' | 's3';

export function resolveStorageProvider(): StorageProvider {
  const explicit = (process.env.STORAGE_PROVIDER ?? '').trim().toLowerCase();
  if (explicit === 'supabase' || explicit === 's3') {
    return explicit;
  }
  if (
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_KEY)
  ) {
    return 'supabase';
  }
  if (
    process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY &&
    process.env.S3_SECRET_KEY
  ) {
    return 's3';
  }
  return 'supabase';
}

export function resolveStorageBucket(provider: StorageProvider): string {
  const fromEnv =
    process.env.SUPABASE_STORAGE_BUCKET ||
    process.env.SUPABASE_BUCKET ||
    process.env.S3_BUCKET ||
    'jardim-das-conquistas';
  if (provider === 'supabase') return fromEnv;
  return process.env.S3_BUCKET || fromEnv;
}