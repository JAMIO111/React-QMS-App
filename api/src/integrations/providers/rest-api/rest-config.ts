import { z } from 'zod';
import { headerProblem } from '../../core/safe-http';

/**
 * A REST connection's settings (no secrets: the credential is in Vault). The database checks the same rules in `app.integration_rest_config_problem`;
 * this schema gives the API the shapes and clearer messages. Every address is built from the connection's base address, so a setting can only ever
 * choose a path on the same host — never another host, port or scheme.
 */

/** A path below the base address: starts with "/", no query or fragment, no "//", "." or ".." segments, no backslash. */
export const REST_PATH = /^(?!.*\/\/)(?!.*%2[eE])(?!.*\/\.{1,2}(\/|$))\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,299}$/;
/** A dotted path into a JSON answer ("data", "meta.next", "@odata.nextLink"): keys of letters, digits, _, -, $ or @. */
export const JSON_PATH = /^[A-Za-z0-9_$@-]{1,60}(\.[A-Za-z0-9_$@-]{1,60}){0,9}$/;
/** A query parameter name. */
export const PARAM = /^[A-Za-z0-9_.\-[\]]{1,60}$/;

export const PAGING_STYLES = ['none', 'page', 'offset', 'cursor', 'next_link'] as const;
export type PagingStyle = (typeof PAGING_STYLES)[number];

const Path = z.string().regex(REST_PATH, 'A path starts with / and stays below the address (no ?, #, // or ..)');
const JsonPath = z.string().regex(JSON_PATH, 'A path into the answer is keys joined by dots, such as data or meta.next');
const Param = z.string().regex(PARAM, 'A parameter name is letters, digits, _ . - [ ]');

export const RestPaging = z
  .object({
    style: z.enum(PAGING_STYLES),
    pageSize: z.number().int().min(1).max(1000).optional(),
    // page numbers
    pageParam: Param.optional(),
    sizeParam: Param.optional(),
    firstPage: z.union([z.literal(0), z.literal(1)]).optional(),
    // offset and limit
    offsetParam: Param.optional(),
    limitParam: Param.optional(),
    // a token from the answer, sent back as a parameter
    cursorParam: Param.optional(),
    nextCursorPath: JsonPath.optional(),
    // a link to the next page, in the answer or in the Link header
    nextLinkPath: z.union([JsonPath, z.literal('header')]).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.style === 'cursor' && !p.nextCursorPath) ctx.addIssue({ code: 'custom', message: 'Say where the answer gives the next cursor', path: ['nextCursorPath'] });
    if (p.style === 'next_link' && !p.nextLinkPath) ctx.addIssue({ code: 'custom', message: 'Say where the answer gives the next page\'s link', path: ['nextLinkPath'] });
  });
export type RestPaging = z.infer<typeof RestPaging>;

export const RestEntity = z
  .object({
    path: Path,
    /** Where the list of records is in the answer (empty: the answer is the list). */
    recordsPath: JsonPath.optional(),
    /** Fixed query parameters sent with every request (no secrets here: they are stored as plain settings). */
    query: z
      .record(Param, z.string().max(200))
      .refine((q) => Object.keys(q).length <= 20, 'At most 20 parameters')
      .optional(),
    paging: RestPaging.optional(),
    /** Incremental import: send `param` = the highest `field` seen last time. */
    incremental: z.object({ param: Param, field: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict();
export type RestEntity = z.infer<typeof RestEntity>;

export const RestConfig = z
  .object({
    baseUrl: z.string().max(300),
    authType: z.enum(['none', 'api_key', 'bearer', 'basic']).optional(),
    apiKeyHeader: z
      .string()
      .optional()
      .superRefine((h, ctx) => {
        if (h === undefined) return;
        const p = headerProblem(h);
        if (p) ctx.addIssue({ code: 'custom', message: p });
      }),
    timeoutSeconds: z.number().int().min(1).max(60).optional(),
    testPath: Path.optional(),
    entities: z.record(z.string().regex(/^[a-z_]{2,40}$/), RestEntity).optional(),
  })
  .strict();
export type RestConfig = z.infer<typeof RestConfig>;

/** The connection's settings, or the first problem in words. */
export function readRestConfig(config: unknown): { ok: true; config: RestConfig } | { ok: false; problem: string } {
  const r = RestConfig.safeParse(config);
  if (r.success) return { ok: true, config: r.data };
  const issue = r.error.issues[0];
  return { ok: false, problem: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

/** The base address joined with a path: "https://erp.example.com/api" + "/v1/parts" → "https://erp.example.com/api/v1/parts". Never leaves the base's origin. */
export function joinUrl(baseUrl: string, path: string | undefined): URL {
  const base = new URL(baseUrl);
  base.search = '';
  base.hash = '';
  if (!path) return base;
  const out = new URL(base.toString());
  out.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  if (out.origin !== base.origin) throw new Error('The path left the connection\'s address');
  return out;
}

/**
 * Own-property walk of a dotted path (never reads inherited properties such as __proto__ or constructor). A key that itself holds dots — OData's
 * "@odata.nextLink" — is found too: at each level the longest run of the remaining keys that is a key of the object is taken first.
 */
export function atPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  const keys = path.split('.');
  let v: unknown = value;
  let i = 0;
  while (i < keys.length) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    let j = keys.length;
    for (; j > i; j--) if (Object.prototype.hasOwnProperty.call(v, keys.slice(i, j).join('.'))) break;
    if (j === i) return undefined;
    v = (v as Record<string, unknown>)[keys.slice(i, j).join('.')];
    i = j;
  }
  return v;
}
