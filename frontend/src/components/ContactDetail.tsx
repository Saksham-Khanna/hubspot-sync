import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Mail, MessageSquare, UserRound } from 'lucide-react';
import { Note, api, fullName } from '../lib/api';
import { Skeleton } from './Skeleton';
import { useToast } from './Toast';

const MAX = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_LABEL: Record<Note['status'], string> = {
  pending: 'Waiting to send',
  syncing: 'Sending to HubSpot',
  synced: 'Synced to HubSpot',
  failed: 'Failed to sync',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';

function NoteItem({ note }: { note: Note }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const retry = useMutation({
    mutationFn: () => api.retryNote(note.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notes', note.contact_id] });
      toast('Note retry queued.', 'ok');
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });
  const tone = note.status === 'synced' ? 'ok' : note.status === 'failed' ? 'bad' : 'muted';
  return (
    <li className="note">
      <p className="note-body">{note.body}</p>
      <div className="note-meta">
        <span className="muted">{when(note.created_at)}</span>
        <span className={`pill ${tone}`}>{STATUS_LABEL[note.status]}</span>
        {note.status === 'failed' && (
          <button className="link" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Retrying…' : 'Try again'}
          </button>
        )}
      </div>
      {note.status === 'failed' && note.last_error && <p className="error-text small">{note.last_error}</p>}
      {retry.isError && <p className="error-text small">{(retry.error as Error).message}</p>}
    </li>
  );
}

function Notes({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const notes = useQuery({
    queryKey: ['notes', contactId],
    queryFn: () => api.notes(contactId),
    // Keep polling while any note is still travelling to HubSpot.
    refetchInterval: (q) => (q.state.data?.data.some((n) => n.status === 'pending' || n.status === 'syncing') ? 2000 : false),
  });
  const add = useMutation({
    mutationFn: (body: string) => api.addNote(contactId, body),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['notes', contactId] });
      void qc.invalidateQueries({ queryKey: ['sync-status'] });
      toast('Note saved — sending to HubSpot.', 'ok');
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });

  const save = () => {
    if (!text.trim() || add.isPending) return;
    add.mutate(text.trim());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className="notes">
      <div className="notes-title">
        <h3>Notes</h3>
        {notes.data && <span className="count">{notes.data.data.length}</span>}
      </div>
      <form onSubmit={submit}>
        <label className="sr-only" htmlFor="note-input">Add a note</label>
        <textarea
          id="note-input"
          rows={3}
          maxLength={MAX}
          placeholder="Add a note. It is saved here first, then sent to HubSpot."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="form-row">
          <span className="muted small">
            {text.length.toLocaleString()} / {MAX.toLocaleString()} · Ctrl+Enter to save
          </span>
          <button className="btn primary" type="submit" disabled={!text.trim() || add.isPending}>
            {add.isPending ? 'Saving…' : 'Add note'}
          </button>
        </div>
        {add.isError && <p className="error-text" role="alert">Could not save the note: {(add.error as Error).message}</p>}
      </form>

      {notes.isLoading && (
        <ul className="note-list" aria-label="Loading notes">
          {[0, 1].map((i) => (
            <li className="note" key={i}>
              <Skeleton className="skeleton-line w60" />
              <Skeleton className="skeleton-line w40" />
            </li>
          ))}
        </ul>
      )}
      {notes.isError && <p className="error-text" role="alert">Could not load notes: {(notes.error as Error).message}</p>}
      {notes.data && notes.data.data.length === 0 && (
        <div className="empty-inline notes-empty">
          <MessageSquare size={22} />
          <p>No notes yet. Add the first one above.</p>
        </div>
      )}
      <ul className="note-list">{notes.data?.data.map((n) => <NoteItem key={n.id} note={n} />)}</ul>
    </div>
  );
}

export function ContactDetailPanel({ contactId }: { contactId: string | null }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const q = useQuery({ queryKey: ['contact', contactId], queryFn: () => api.contact(contactId!), enabled: !!contactId });

  const copyEmail = async (email: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is not available');
      await navigator.clipboard.writeText(email);
      setCopied(true);
      toast('Email copied to clipboard.', 'ok');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('Could not copy the email. Select it manually.', 'error');
    }
  };

  if (!contactId) {
    return (
      <section className="card detail">
        <div className="empty-inline detail-empty">
          <UserRound size={28} />
          <h3>Select a contact</h3>
          <p>Pick someone from the list to see their details and notes.</p>
        </div>
      </section>
    );
  }
  if (q.isLoading) {
    return (
      <section className="card detail" aria-label="Loading contact">
        <div className="detail-header">
          <div className="detail-person">
            <Skeleton className="skeleton-avatar" />
            <div style={{ flex: 1 }}>
              <Skeleton className="skeleton-line w40" />
              <Skeleton className="skeleton-line w60" />
            </div>
          </div>
        </div>
        <div className="detail-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="skeleton-line w40" />
              <Skeleton className="skeleton-line w80" />
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (q.isError) {
    return (
      <section className="card detail">
        <div className="banner error inline" role="alert">
          <span>Could not load this contact: {(q.error as Error).message}</span>
          <button className="link" onClick={() => q.refetch()}>Retry</button>
        </div>
      </section>
    );
  }
  const c = q.data!;
  const name = fullName(c);
  const email = c.email;
  const fields: [string, string | null][] = [
    ['Phone', c.phone],
    ['Company', c.company],
    ['HubSpot ID', c.hubspot_id],
    ['Created in HubSpot', c.hs_created_at ? when(c.hs_created_at) : null],
    ['Last synced', when(c.synced_at)],
  ];
  return (
    <section className="card detail">
      <div className="detail-header">
        <div className="detail-person">
          <div className="avatar">{initials(name)}</div>
          <div style={{ minWidth: 0 }}>
            <h2>{name}</h2>
            {email ? (
              <button className="email-copy" type="button" onClick={() => void copyEmail(email)} aria-label={`Copy email ${email}`}>
                <Mail size={14} />
                <span>{email}</span>
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            ) : (
              <span className="muted small">No email address</span>
            )}
          </div>
        </div>
        {c.lifecycle_stage && <span className="pill primary">{c.lifecycle_stage}</span>}
      </div>
      <dl className="fields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? <span className="muted">Not set</span>}</dd>
          </div>
        ))}
      </dl>
      <Notes contactId={c.id} />
    </section>
  );
}
