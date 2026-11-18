import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import {
  applyParsedOverlay,
  parseEnvFileContent,
} from './storage-env-overlay';

describe('storage-env-overlay', () => {
  const tmpPath = resolve(__dirname, '__tmp_env_overlay_test.env');

  afterEach(() => {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  });

  it('parses key=value lines and strips quotes', () => {
    const parsed = parseEnvFileContent(`
# comment
SUPABASE_URL=https://supabase.example.com
STORAGE_PROVIDER=supabase
JWT_SHOULD_NOT=evil
    `);
    expect(parsed.SUPABASE_URL).toBe('https://supabase.example.com');
    expect(parsed.STORAGE_PROVIDER).toBe('supabase');
  });

  it('applies only storage keys and maps PUBLIC_BASE_URL to ASSETS_PUBLIC_BASE_URL', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://local',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    };
    const applied = applyParsedOverlay(
      {
        DATABASE_URL: 'postgres://should-not-apply',
        SUPABASE_URL: 'https://supabase.sowtech.io',
        SUPABASE_SERVICE_ROLE_KEY: 'role-key',
        PUBLIC_BASE_URL: 'https://api.sowtech.io',
      },
      env,
    );

    expect(env.DATABASE_URL).toBe('postgres://local');
    expect(env.SUPABASE_URL).toBe('https://supabase.sowtech.io');
    expect(env.ASSETS_PUBLIC_BASE_URL).toBe('https://api.sowtech.io');
    expect(env.PUBLIC_BASE_URL).toBe('http://localhost:3000');
    expect(applied).toContain('SUPABASE_URL');
    expect(applied).toContain('ASSETS_PUBLIC_BASE_URL(from PUBLIC_BASE_URL)');
  });

  it('ASSETS_PUBLIC_BASE_URL in overlay wins over PUBLIC_BASE_URL mapping', () => {
    const env: NodeJS.ProcessEnv = {};
    applyParsedOverlay(
      {
        PUBLIC_BASE_URL: 'https://api.example.com',
        ASSETS_PUBLIC_BASE_URL: 'https://cdn.example.com',
      },
      env,
    );
    expect(env.ASSETS_PUBLIC_BASE_URL).toBe('https://cdn.example.com');
  });

  it('loads file via parse flow', () => {
    writeFileSync(
      tmpPath,
      'SUPABASE_URL=https://file.example.com\nPUBLIC_BASE_URL=https://api.file.example\n',
    );
    const parsed = parseEnvFileContent(readFileSync(tmpPath, 'utf8'));
    const env: NodeJS.ProcessEnv = {};
    applyParsedOverlay(parsed, env);
    expect(env.SUPABASE_URL).toBe('https://file.example.com');
    expect(env.ASSETS_PUBLIC_BASE_URL).toBe('https://api.file.example');
  });
});