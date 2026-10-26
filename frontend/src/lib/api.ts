export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? `Request failed (${res.status})`, res.status, body.error);
  }
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  connected: boolean;
  needsReauth?: boolean;
  hubId?: number;
  hubDomain?: string | null;
  userEmail?: string | null;
  lastSyncedAt?: string | null;
}
export interface Contact {
  id: string;
  hubspot_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  company: string | null;
  lifecycle_stage: string | null;
  hs_created_at: string | null;
  synced_at: string;
}
export interface ContactDetail extends Contact {
  properties: Record<string, string | null>;
  hs_updated_at: string | null;
}
export interface ContactsPage {
  data: Contact[];
  page: number;
  pageSize: number;
  total: number;
}
export type NoteStatus = 'pending' | 'syncing' | 'synced' | 'failed';
export interface Note {
  id: string;
  contact_id: string;
  body: string;
  status: NoteStatus;
  hubspot_note_id: string | null;
  last_error: string | null;
  created_at: string;
  synced_at: string | null;
}
export interface SyncJob {
  id: string;
  type: 'full' | 'incremental';
  status: 'pending' | 'running' | 'completed' | 'failed';
  pages: number;
  contacts_synced: number;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface SyncStatus {
  latest: SyncJob | null;
  contacts: number;
  notes: Record<NoteStatus, number>;
  queue: { waiting: number; active: number; delayed: number; failed: number };
}

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),
  disconnect: () => request<{ ok: true }>('/auth/disconnect', { method: 'POST' }),
  contacts: (p: { search: string; page: number; pageSize: number }) => {
    const qs = new URLSearchParams({ page: String(p.page), pageSize: String(p.pageSize) });
    if (p.search) qs.set('search', p.search);
    return request<ContactsPage>(`/contacts?${qs}`);
  },
  contact: (id: string) => request<ContactDetail>(`/contacts/${id}`),
  notes: (id: string) => request<{ data: Note[] }>(`/contacts/${id}/notes`),
  addNote: (id: string, body: string) => request<Note>(`/contacts/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  retryNote: (id: string) => request<{ ok: true }>(`/notes/${id}/retry`, { method: 'POST' }),
  syncStatus: () => request<SyncStatus>('/sync/status'),
  retrySync: () => request<{ resumed: boolean }>('/sync/retry', { method: 'POST' }),
};

export const fullName = (c: Pick<Contact, 'first_name' | 'last_name' | 'email'>) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed contact';
