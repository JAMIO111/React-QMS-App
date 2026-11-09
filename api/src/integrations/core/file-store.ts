import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../../config/env';

/**
 * Where uploaded import files are read from. The browser uploads to the private `integration-files` bucket (storage policies limit it to the connection's own
 * folder); the API fetches the object to parse it. Tests substitute an in-memory store.
 */
export abstract class IntegrationFileStore {
  abstract get enabled(): boolean;
  /** The bytes of the object at `path` in the integration-files bucket, or null when there is no such object. */
  abstract download(path: string): Promise<Uint8Array | null>;
}

/** Reads from Supabase Storage with the service key (server side only; the key never reaches a browser). */
@Injectable()
export class SupabaseIntegrationFileStore extends IntegrationFileStore {
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  get enabled(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  async download(path: string): Promise<Uint8Array | null> {
    const url = `${this.env.SUPABASE_URL!.replace(/\/$/, '')}/storage/v1/object/integration-files/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
