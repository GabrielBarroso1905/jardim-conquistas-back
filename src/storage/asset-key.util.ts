export type ExtractAssetKeyOptions = {
  bucket?: string;
  endpoint?: string;
};

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isGarageHost(hostname: string, endpoint?: string): boolean {
  if (hostname.includes('coolify.chebl.cloud')) return true;
  if (hostname.includes('coolify.cloud')) return true;
  const endpointHost = hostnameOf(endpoint);
  return Boolean(endpointHost && hostname === endpointHost);
}

/**
 * Extracts an S3 object key from a stored asset value.
 * Returns the key for `assets/...` paths and Garage/Coolify URLs.
 * Returns null for Supabase public URLs and unknown values.
 */
export function extractAssetKey(
  value: string,
  options: ExtractAssetKeyOptions = {},
): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('assets/')) return trimmed;

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const fromSupabase = extractSupabaseStorageObjectPath(url);
  if (fromSupabase) return fromSupabase;

  const bucket =
    options.bucket || process.env.S3_BUCKET || 'jardim-das-conquistas';
  const endpoint = options.endpoint || process.env.S3_ENDPOINT;
  const pathname = url.pathname;
  const marker = `/${bucket}/`;
  const index = pathname.indexOf(marker);

  if (index !== -1 && isGarageHost(url.hostname, endpoint)) {
    return decodeURIComponent(pathname.substring(index + marker.length));
  }

  if (index !== -1) {
    return decodeURIComponent(pathname.substring(index + marker.length));
  }

  return null;
}

/** Path do objeto dentro do bucket (assets/...) a partir de URL do Storage Supabase. */
export function extractSupabaseStorageObjectPath(url: URL): string | null {
  const m = url.pathname.match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/[^/]+\/(.+)/,
  );
  if (!m?.[1]) return null;
  return decodeURIComponent(m[1].replace(/^\/+/, ''));
}

export function isSupabaseStorageUrl(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('http')) return false;
  try {
    const url = new URL(value);
    return (
      url.pathname.includes('/storage/v1/object/') &&
      Boolean(extractSupabaseStorageObjectPath(url))
    );
  } catch {
    return false;
  }
}

/** @deprecated Use isSupabaseStorageUrl — bucket privado não deve usar URL pública. */
export function isSupabasePublicUrl(value: string): boolean {
  return isSupabaseStorageUrl(value);
}

/**
 * Normalizes a world background path to a Garage key.
 * `assets/...` stays as-is. Supabase pointers and `words/...` gain the
 * `assets/` prefix. Local filesystem paths are left unchanged.
 */
export function normalizeWorldSvgKey(value: string): string {
  if (!value || typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('assets/')) return trimmed;

  const supabase = /^supabase:\/\/[^/]+\/(.+)$/.exec(trimmed);
  if (supabase) {
    const rest = supabase[1].replace(/^\/+/, '');
    return rest.startsWith('assets/') ? rest : `assets/${rest}`;
  }

  if (trimmed.startsWith('words/')) return `assets/${trimmed}`;

  return trimmed;
}

/**
 * Maps a stored world background path to a Garage object key.
 * `supabase://bucket/words/lago/Lago.svg` and `assets/words/lago/Lago.svg` both become `assets/words/lago/Lago.svg`.
 */
export function worldBackgroundAssetKey(svgPath: string | null | undefined): string | null {
  if (!svgPath || typeof svgPath !== 'string') return null;
  const trimmed = svgPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('assets/')) return trimmed;
  if (!trimmed.startsWith('supabase://')) return null;

  const parts = trimmed.replace(/^supabase:\/\//, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  parts.shift();
  return `assets/${parts.join('/')}`;
}
