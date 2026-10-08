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

  if (
    url.hostname.includes('supabase.co') &&
    url.pathname.includes('/storage/v1/object/public/')
  ) {
    return null;
  }

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

export function isSupabasePublicUrl(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.includes('supabase.co/storage/v1/object/public/')
  );
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
