import { Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from './supabase-client.factory';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    const client = createSupabaseAdminClient();
    if (!client) {
      throw new Error(
        'Supabase não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (recomendado) ou SUPABASE_KEY',
      );
    }
    this.client = client;
  }

  getClient() {
    return this.client;
  }

  async getSvgFromStorage(bucket: string, filename: string): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .download(filename);
    if (error) throw error;
    if (!data) throw new Error('Arquivo não encontrado');
    return await data.text();
  }
}
