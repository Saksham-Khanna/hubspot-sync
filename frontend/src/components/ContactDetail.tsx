import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Note, api, fullName } from '../lib/api';

const MAX = 10_000;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_LABEL: Record<Note['status'], string> = {
  pending: 'Waiting to send',
  syncing: 'Sending to HubSpot',
  synced: 'Synced to HubSpot',
  failed: 'Failed to sync',
};

function NoteItem({ note }: { note: Note }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryNote(note.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notes', note.contact_id] }),
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
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['notes', contactId] });
      void qc.invalidateQueries({ queryKey: ['sync-status'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || add.isPending) return;
    setSaved(false);
    add.mutate(text.trim());
  };

  return (
    <div className="notes">
      <h3>Notes</h3>
      <form onSubmit={submit}>
        <label className="sr-only" htmlFor="note-input">Add a note</label>
        <textarea
          id="note-input"
          rows={3}
          maxLength={MAX}
          placeholder="Add a note. It is saved here first, then sent to HubSpot."
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
        />
        <div className="form-row">
          <span className="muted small">{text.length.toLocaleString()} / {MAX.toLocaleString()}</span>
          <button className="btn primary" type="submit" disabled={!text.trim() || add.isPending}>
            {add.isPending ? 'Saving…' : 'Add note'}
          </button>
        </div>
        {saved && <p className="ok-text" role="status">Note saved. It is being sent to HubSpot.</p>}
        {add.isError && <p className="error-text" role="alert">Could not save the note: {(add.error as Error).message}</p>}
      </form>

      {notes.isLoading && <p className="muted">Loading notes…</p>}
      {notes.isError && <p className="error-text" role="alert">Could not load notes: {(notes.error as Error).message}</p>}
      {notes.data && notes.data.data.length === 0 && <p className="muted">No notes yet for this contact.</p>}
      <ul className="note-list">{notes.data?.data.map((n) => <NoteItem key={n.id} note={n} />)}</ul>
    </div>
  );
}

export function ContactDetailPanel({ contactId }: { contactId: string | null }) {
  const q = useQuery({ queryKey: ['contact', contactId], queryFn: () => api.contact(contactId!), enabled: !!contactId });

  if (!contactId) {
    return <section className="card detail"><p className="muted pad">Select a contact to see details and notes.</p></section>;
  }
  if (q.isLoading) return <section className="card detail"><p className="muted pad">Loading contact…</p></section>;
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
  const fields: [string, string | null][] = [
    ['Email', c.email],
    ['Phone', c.phone],
    ['Company', c.company],
    ['Lifecycle stage', c.lifecycle_stage],
    ['HubSpot ID', c.hubspot_id],
    ['Created in HubSpot', c.hs_created_at ? when(c.hs_created_at) : null],
    ['Last synced', when(c.synced_at)],
  ];
  return (
    <section className="card detail">
      <h2>{fullName(c)}</h2>
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
