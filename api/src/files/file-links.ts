import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../config/env';

/**
 * Signs short-lived Supabase Storage links with the service key, after the API has checked the person, the file's rule and the network
 * (docs/security-plan.md S3). The key never reaches a browser. Tests substitute a fake.
 */
export abstract class FileLinkSigner {
  abstract get enabled(): boolean;
  /** A link that downloads `path` until it expires, or null when there is no such object. */
  abstract signDownload(bucket: string, path: string, expiresIn: number, downloadName?: string): Promise<string | null>;
  /** A one-path upload token (Supabase signed upload URLs are valid for two hours and refuse an existing object). */
  abstract signUpload(bucket: string, path: string): Promise<{ token: string; signedUrl: string }>;
  abstract remove(bucket: string, path: string): Promise<void>;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

@Injectable()
export class SupabaseFileLinkSigner extends FileLinkSigner {
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  get enabled(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  private get base() {
    return `${this.env.SUPABASE_URL!.replace(/\/$/, '')}/storage/v1`;
  }

  private headers(json = true): Record<string, string> {
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY!;
    return { apikey: key, Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async signDownload(bucket: string, path: string, expiresIn: number, downloadName?: string): Promise<string | null> {
    const res = await fetch(`${this.base}/object/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ expiresIn }),
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage answered ${res.status}`);
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) return null;
    const url = `${this.base}${body.signedURL}`;
    return downloadName ? `${url}&download=${encodeURIComponent(downloadName)}` : url;
  }

  async signUpload(bucket: string, path: string): Promise<{ token: string; signedUrl: string }> {
    const res = await fetch(`${this.base}/object/upload/sign/${encodeURIComponent(bucket)}/${encodePath(path)}`, { method: 'POST', headers: this.headers(false) });
    if (!res.ok) throw new Error(`Storage answered ${res.status}`);
    const body = (await res.json()) as { url?: string };
    const token = body.url ? new URL(body.url, 'http://x').searchParams.get('token') : null;
    if (!token) throw new Error('Storage gave no upload token');
    return { token, signedUrl: `${this.base}${body.url}` };
  }

  async remove(bucket: string, path: string): Promise<void> {
    const res = await fetch(`${this.base}/object/${encodeURIComponent(bucket)}`, { method: 'DELETE', headers: this.headers(), body: JSON.stringify({ prefixes: [path] }) });
    if (!res.ok && res.status !== 404) throw new Error(`Storage answered ${res.status}`);
  }
}
