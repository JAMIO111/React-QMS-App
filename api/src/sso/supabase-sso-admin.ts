import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../config/env';

/** What the company's IT gives us: the address of their SAML metadata, or the metadata file itself. */
export type SamlMetadata = { metadataUrl: string } | { metadataXml: string };

export interface SsoProviderRecord {
  id: string;
  entityId: string | null;
  domains: string[];
}

/** A refusal from Supabase that the person can act on (bad metadata, a domain held elsewhere): shown as 409 sso_rule with Supabase's words. */
export class SsoAdminRefused extends Error {}
/** Supabase could not be reached or failed: try again later. */
export class SsoAdminUnavailable extends Error {}

/**
 * Registers organisations' SAML identity providers with Supabase Auth (docs/sso-plan.md SS2) through the Management API. The token lives only in
 * the API's environment (SUPABASE_MANAGEMENT_TOKEN, a token scoped to this project and Auth Config: Read-write); it never reaches a browser or
 * the database. Tests substitute a fake.
 */
export abstract class SupabaseSsoAdmin {
  abstract get enabled(): boolean;
  abstract create(metadata: SamlMetadata, domains: string[]): Promise<SsoProviderRecord>;
  /** Replaces the metadata and/or the domains of a provider. */
  abstract update(id: string, change: { metadata?: SamlMetadata; domains?: string[] }): Promise<SsoProviderRecord>;
  /** Removes a provider; one that is already gone counts as removed. */
  abstract remove(id: string): Promise<void>;
}

/**
 * The SAML attributes Fortress asks for, under the names identity providers commonly send them (Microsoft Entra, Okta, Google Workspace, ADFS).
 * Supabase stores them on the new user as given_name / family_name / name, which app.handle_new_user turns into the profile's names. The email
 * address is found by Supabase itself.
 */
export const ATTRIBUTE_MAPPING = {
  keys: {
    given_name: {
      names: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'givenName', 'urn:oid:2.5.4.42', 'firstName', 'first_name'],
    },
    family_name: {
      names: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'sn', 'surname', 'urn:oid:2.5.4.4', 'lastName', 'last_name'],
    },
    name: {
      names: ['http://schemas.microsoft.com/identity/claims/displayname', 'displayName', 'urn:oid:2.16.840.1.113730.3.1.241', 'name'],
    },
  },
} as const;

/** The project's reference: SUPABASE_PROJECT_REF, else the first label of a *.supabase.co SUPABASE_URL. */
export function projectRef(env: Pick<Env, 'SUPABASE_URL'> & { SUPABASE_PROJECT_REF?: string }): string | null {
  if (env.SUPABASE_PROJECT_REF) return env.SUPABASE_PROJECT_REF;
  try {
    const host = new URL(env.SUPABASE_URL ?? '').hostname;
    const m = /^([a-z0-9]{10,40})\.supabase\.(co|com|in)$/.exec(host);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The values the company's IT enters for Fortress (Supabase is the SAML service provider). */
export function serviceProviderValues(supabaseUrl: string | undefined) {
  if (!supabaseUrl) return null;
  const base = supabaseUrl.replace(/\/$/, '');
  return {
    entityId: `${base}/auth/v1/sso/saml/metadata`,
    acsUrl: `${base}/auth/v1/sso/saml/acs`,
    metadataUrl: `${base}/auth/v1/sso/saml/metadata`,
    metadataDownloadUrl: `${base}/auth/v1/sso/saml/metadata?download=true`,
  };
}

const metadataBody = (m: SamlMetadata) => ('metadataUrl' in m ? { metadata_url: m.metadataUrl } : { metadata_xml: m.metadataXml });

@Injectable()
export class ManagementApiSsoAdmin extends SupabaseSsoAdmin {
  private readonly base = 'https://api.supabase.com';

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  get enabled(): boolean {
    return Boolean(this.env.SUPABASE_MANAGEMENT_TOKEN && projectRef(this.env));
  }

  create(metadata: SamlMetadata, domains: string[]) {
    return this.call('POST', '', { type: 'saml', ...metadataBody(metadata), domains, attribute_mapping: ATTRIBUTE_MAPPING });
  }

  update(id: string, change: { metadata?: SamlMetadata; domains?: string[] }) {
    return this.call('PUT', `/${encodeURIComponent(id)}`, {
      ...(change.metadata ? { ...metadataBody(change.metadata), attribute_mapping: ATTRIBUTE_MAPPING } : {}),
      ...(change.domains ? { domains: change.domains } : {}),
    });
  }

  async remove(id: string) {
    try {
      await this.call('DELETE', `/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof SsoAdminRefused && /not found/i.test(e.message)) return;
      throw e;
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<SsoProviderRecord> {
    const url = `${this.base}/v1/projects/${projectRef(this.env)}/config/auth/sso/providers${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.env.SUPABASE_MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new SsoAdminUnavailable('Supabase could not be reached');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.status === 404) throw new SsoAdminRefused('That provider was not found in Supabase');
    if (res.status === 401 || res.status === 403) throw new SsoAdminUnavailable('The Supabase management token was refused');
    if (res.status >= 400 && res.status < 500) {
      const message = String(json.message ?? json.msg ?? json.error ?? `Supabase refused it (${res.status})`).slice(0, 300);
      throw new SsoAdminRefused(message);
    }
    if (!res.ok) throw new SsoAdminUnavailable(`Supabase answered ${res.status}`);
    const saml = (json.saml ?? {}) as Record<string, unknown>;
    const domains = Array.isArray(json.domains) ? (json.domains as Array<{ domain?: string }>).map((d) => String(d.domain ?? '')).filter(Boolean) : [];
    return { id: String(json.id ?? ''), entityId: (saml.entity_id as string) ?? null, domains };
  }
}
