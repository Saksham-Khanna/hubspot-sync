import { config } from '../config';
import { HubSpotError } from '../lib/errors';
import { hubspotRequests } from '../lib/metrics';

export const CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'company',
  'lifecyclestage',
  'createdate',
  'lastmodifieddate',
];

// HubSpot-defined association type id: note -> contact.
const NOTE_TO_CONTACT = 202;
const REQUEST_TIMEOUT_MS = 15_000;

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
export interface TokenInfo {
  hub_id: number;
  hub_domain?: string;
  user?: string;
  scopes?: string[];
}

export interface HubSpotContactRaw {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}
export interface MappedContact {
  hubspotId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  company: string | null;
  lifecycleStage: string | null;
  hsCreatedAt: string | null;
  hsUpdatedAt: string | null;
  properties: Record<string, string | null>;
}
export interface ContactsPage {
  contacts: MappedContact[];
  next: string | null;
  total?: number;
}

const blank = (v: string | null | undefined) => (v && v.trim() !== '' ? v : null);

export function mapContact(raw: HubSpotContactRaw): MappedContact {
  const p = raw.properties ?? {};
  return {
    hubspotId: String(raw.id),
    email: blank(p.email),
    firstName: blank(p.firstname),
    lastName: blank(p.lastname),
    phone: blank(p.phone),
    company: blank(p.company),
    lifecycleStage: blank(p.lifecyclestage),
    hsCreatedAt: raw.createdAt ?? blank(p.createdate),
    hsUpdatedAt: raw.updatedAt ?? blank(p.lastmodifieddate),
    properties: p,
  };
}

function parseRetryAfter(res: Response): number {
  const header = res.headers.get('retry-after');
  const secs = header ? Number(header) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const interval = Number(res.headers.get('x-hubspot-ratelimit-interval-milliseconds'));
  return Number.isFinite(interval) && interval > 0 ? interval : 10_000;
}

interface ReqOpts {
  token?: string;
  query?: Record<string, string | number | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  /** Low-cardinality label for metrics. */
  endpoint: string;
}

async function request<T>(method: string, path: string, opts: ReqOpts): Promise<T> {
  const url = new URL(path, config.HUBSPOT_API_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    hubspotRequests.inc({ endpoint: opts.endpoint, status: 'network_error' });
    // Network failures/timeouts are transient: surface as 503 so they are classed retryable.
    throw new HubSpotError(`network error calling ${opts.endpoint}: ${(err as Error).message}`, 503, null);
  }
  hubspotRequests.inc({ endpoint: opts.endpoint, status: String(res.status) });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = (parsed as { message?: string } | null)?.message ?? res.statusText;
    throw new HubSpotError(msg, res.status, parsed, res.status === 429 ? parseRetryAfter(res) : undefined);
  }
  return parsed as T;
}

export const hubspot = {
  buildAuthorizeUrl(state: string): string {
    const u = new URL(config.HUBSPOT_AUTH_URL);
    u.searchParams.set('client_id', config.HUBSPOT_CLIENT_ID);
    u.searchParams.set('redirect_uri', config.HUBSPOT_REDIRECT_URI);
    u.searchParams.set('scope', config.HUBSPOT_SCOPES);
    u.searchParams.set('state', state);
    return u.toString();
  },

  exchangeCode(code: string): Promise<TokenResponse> {
    return request('POST', '/oauth/v1/token', {
      endpoint: 'oauth_token',
      form: {
        grant_type: 'authorization_code',
        client_id: config.HUBSPOT_CLIENT_ID,
        client_secret: config.HUBSPOT_CLIENT_SECRET,
        redirect_uri: config.HUBSPOT_REDIRECT_URI,
        code,
      },
    });
  },

  refreshToken(refreshToken: string): Promise<TokenResponse> {
    return request('POST', '/oauth/v1/token', {
      endpoint: 'oauth_token',
      form: {
        grant_type: 'refresh_token',
        client_id: config.HUBSPOT_CLIENT_ID,
        client_secret: config.HUBSPOT_CLIENT_SECRET,
        refresh_token: refreshToken,
      },
    });
  },

  getTokenInfo(accessToken: string): Promise<TokenInfo> {
    return request('GET', `/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, { endpoint: 'token_info' });
  },

  /** Full sync: GET /crm/v3/objects/contacts, cursor-paginated (`after`). */
  async listContacts(token: string, args: { after?: string | null; limit: number }): Promise<ContactsPage> {
    const res = await request<{
      results: HubSpotContactRaw[];
      paging?: { next?: { after?: string } };
    }>('GET', '/crm/v3/objects/contacts', {
      token,
      endpoint: 'contacts_list',
      query: { limit: args.limit, after: args.after, properties: CONTACT_PROPERTIES.join(',') },
    });
    return { contacts: res.results.map(mapContact), next: res.paging?.next?.after ?? null };
  },

  /** Incremental sync: search by last-modified, oldest first. Search caps at 10k results per query. */
  async searchModifiedContacts(token: string, args: { since: Date; after?: string | null; limit: number }): Promise<ContactsPage> {
    const res = await request<{
      total: number;
      results: HubSpotContactRaw[];
      paging?: { next?: { after?: string } };
    }>('POST', '/crm/v3/objects/contacts/search', {
      token,
      endpoint: 'contacts_search',
      json: {
        filterGroups: [
          { filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(args.since.getTime()) }] },
        ],
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
        properties: CONTACT_PROPERTIES,
        limit: args.limit,
        after: args.after ?? undefined,
      },
    });
    return { contacts: res.results.map(mapContact), next: res.paging?.next?.after ?? null, total: res.total };
  },

  /** Webhook-driven refresh of specific contacts (max 100 ids per call). */
  async batchReadContacts(token: string, ids: string[]): Promise<MappedContact[]> {
    const res = await request<{ results: HubSpotContactRaw[] }>('POST', '/crm/v3/objects/contacts/batch/read', {
      token,
      endpoint: 'contacts_batch_read',
      json: { properties: CONTACT_PROPERTIES, inputs: ids.map((id) => ({ id })) },
    });
    return res.results.map(mapContact);
  },

  async createNote(token: string, contactHubspotId: string, htmlBody: string, timestamp: Date): Promise<string> {
    const res = await request<{ id: string }>('POST', '/crm/v3/objects/notes', {
      token,
      endpoint: 'notes_create',
      json: {
        properties: { hs_timestamp: timestamp.toISOString(), hs_note_body: htmlBody },
        associations: [
          {
            to: { id: contactHubspotId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      },
    });
    return res.id;
  },

  /**
   * HubSpot has no idempotency keys for note creation. Before re-creating a note whose previous
   * attempt may have succeeded server-side, look for our `[ref:<noteId>]` marker among the notes
   * already associated with the contact. Looks at the first 500 associations only.
   */
  async findNoteByRef(token: string, contactHubspotId: string, ref: string): Promise<string | null> {
    const assoc = await request<{ results: { toObjectId: number | string }[] }>(
      'GET',
      `/crm/v4/objects/contacts/${encodeURIComponent(contactHubspotId)}/associations/notes`,
      { token, endpoint: 'note_assoc_list', query: { limit: 500 } },
    );
    const ids = assoc.results.map((r) => String(r.toObjectId));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const notes = await request<{ results: { id: string; properties: { hs_note_body?: string | null } }[] }>(
        'POST',
        '/crm/v3/objects/notes/batch/read',
        { token, endpoint: 'notes_batch_read', json: { properties: ['hs_note_body'], inputs: chunk.map((id) => ({ id })) } },
      );
      const hit = notes.results.find((n) => n.properties.hs_note_body?.includes(`[ref:${ref}]`));
      if (hit) return hit.id;
    }
    return null;
  },
};

export function buildNoteHtml(body: string, noteId: string): string {
  const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return `<p>${esc}</p><p>[ref:${noteId}]</p>`;
}
