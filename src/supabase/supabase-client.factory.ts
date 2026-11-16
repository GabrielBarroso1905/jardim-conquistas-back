import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function normalizeSupabaseUrl(url: string | undefined): string {
  const t = (url ?? '').trim();
  if (!t) return '';
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  return `https://${t}`;
}

/** Cliente servidor (service role preferido) para Storage privado e imports. */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const url = normalizeSupabaseUrl(process.env.SUPABASE_URL);
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}