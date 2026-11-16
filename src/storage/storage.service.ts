import { Injectable } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'stream';
import { extractAssetKey } from './asset-key.util';
import {
  resolveStorageBucket,
  resolveStorageProvider,
  type StorageProvider,
} from './storage-provider.util';
import { createSupabaseAdminClient } from '../supabase/supabase-client.factory';

type SignedCacheEntry = { url: string; expiresAt: number };

export type S3ObjectResult = {
  body: Readable | null;
  contentType?: string;
  contentLength?: number;
};

@Injectable()
export class StorageService {
  private readonly provider: StorageProvider;
  private readonly client: S3Client | null;
  private readonly supabase: SupabaseClient | null;
  private readonly bucket: string;
  private readonly expiresIn: number;
  private readonly useAssetProxy: boolean;
  private readonly publicBaseUrl: string;
  private readonly cache = new Map<string, SignedCacheEntry>();

  constructor() {
    this.provider = resolveStorageProvider();
    this.bucket = resolveStorageBucket(this.provider);
    this.expiresIn = Number(process.env.S3_PRESIGNED_EXPIRES || 3600);
    this.useAssetProxy =
      process.env.S3_ASSET_PROXY === 'true' ||
      process.env.S3_ASSET_PROXY === '1';
    this.publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

    if (this.provider === 'supabase') {
      this.supabase = createSupabaseAdminClient();
      this.client = null;
      if (!this.supabase) {
        throw new Error(
          'STORAGE_PROVIDER=supabase requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_KEY) no servidor',
        );
      }
    } else {
      this.supabase = null;
      this.client = new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || 'garage',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY || '',
          secretAccessKey: process.env.S3_SECRET_KEY || '',
        },
        forcePathStyle: true,
      });
    }
  }

  buildProxyUrl(key: string): string {
    if (!this.publicBaseUrl) {
      throw new Error(
        'PUBLIC_BASE_URL is required when S3_ASSET_PROXY is enabled',
      );
    }
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.publicBaseUrl}/api/assets/${encoded}`;
  }

  async getObject(key: string): Promise<S3ObjectResult> {
    if (!key || !this.bucket) {
      return { body: null };
    }

    if (this.provider === 'supabase') {
      return this.getObjectFromSupabase(key);
    }

    try {
      const response = await this.client!.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      return {
        body: (response.Body as Readable) ?? null,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
      };
    } catch (err) {
      if (isMissingS3Object(err)) return { body: null };
      throw err;
    }
  }

  private async getObjectFromSupabase(key: string): Promise<S3ObjectResult> {
    const { data, error } = await this.supabase!.storage
      .from(this.bucket)
      .download(key);

    if (error) {
      if (isSupabaseNotFound(error)) return { body: null };
      throw error;
    }
    if (!data) return { body: null };

    const buffer = Buffer.from(await data.arrayBuffer());
    return {
      body: Readable.from(buffer),
      contentType: data.type || guessContentType(key),
      contentLength: buffer.length,
    };
  }

  async getSignedUrl(key: string, expiresIn = this.expiresIn): Promise<string> {
    if (!key) return key;
    if (this.useAssetProxy && this.publicBaseUrl) {
      return this.buildProxyUrl(key);
    }
    if (!this.bucket) {
      throw new Error('Storage bucket is not configured');
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    let url: string;
    if (this.provider === 'supabase') {
      const { data, error } = await this.supabase!.storage
        .from(this.bucket)
        .createSignedUrl(key, expiresIn);
      if (error || !data?.signedUrl) {
        throw error ?? new Error(`signed URL failed for ${key}`);
      }
      url = data.signedUrl;
    } else {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      url = await getSignedUrl(this.client!, command, { expiresIn });
    }

    const cacheTtlMs = Math.max(0, expiresIn - 60) * 1000;
    this.cache.set(key, { url, expiresAt: Date.now() + cacheTtlMs });
    return url;
  }

  async resolveAsset(value: string): Promise<string> {
    if (!value) return value;

    const key = extractAssetKey(value, {
      bucket: this.bucket,
      endpoint: process.env.S3_ENDPOINT,
    });
    if (key) {
      if (this.useAssetProxy && this.publicBaseUrl) {
        return this.buildProxyUrl(key);
      }
      return this.getSignedUrl(key);
    }

    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }

    return value;
  }

  async signStages(stages: any): Promise<any> {
    if (!stages || typeof stages !== 'object') return stages;

    const result = structuredClone(stages);
    const entries = Array.isArray(result) ? result : Object.values(result);

    for (const stage of entries) {
      if (!stage || typeof stage !== 'object') continue;
      if (typeof stage.svg === 'string') {
        stage.svg = await this.resolveAsset(stage.svg);
      }
      if (typeof stage.png === 'string') {
        stage.png = await this.resolveAsset(stage.png);
      }
    }

    return result;
  }

  async signTreeCatalog<T extends { stages?: any }>(
    catalog: T | null | undefined,
  ): Promise<T | null | undefined> {
    if (!catalog) return catalog;
    return {
      ...catalog,
      stages: await this.signStages(catalog.stages),
    };
  }

  async signPlantedTree<T extends { treeCatalog?: any }>(
    planted: T | null | undefined,
  ): Promise<T | null | undefined> {
    if (!planted?.treeCatalog) return planted;
    return {
      ...planted,
      treeCatalog: await this.signTreeCatalog(planted.treeCatalog),
    };
  }
}

function guessContentType(key: string): string {
  if (key.endsWith('.svg')) return 'image/svg+xml';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function isMissingS3Object(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = error.name || error.Code;
  if (code === 'NoSuchKey' || code === 'NotFound') return true;
  return error.$metadata?.httpStatusCode === 404;
}

function isSupabaseNotFound(err: { message?: string; statusCode?: string }): boolean {
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('not found') || msg.includes('object not found')) return true;
  return err.statusCode === '404';
}