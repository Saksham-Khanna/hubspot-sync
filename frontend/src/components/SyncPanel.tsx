import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const ago = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** Sync status dashboard: progress of the automatic sync, note delivery, and queue health. */
export function SyncPanel() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.syncStatus,
    // Poll quickly while work is in flight, slowly otherwise.
    refetchInterval: (q) => {
      const d = q.state.data;
      const busy = d?.latest?.status === 'running' || d?.latest?.status === 'pending' || (d?.notes.pending ?? 0) + (d?.notes.syncing ?? 0) > 0;
      return busy ? 2000 : 15000;
    },
  });
  const retry = useMutation({
    mutationFn: api.retrySync,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-status'] }),
  });

  if (status.isLoading) return <section className="card sync"><span className="muted">Loading sync status…</span></section>;
  if (status.isError) {
    return (
      <section className="card sync">
        <span className="error-text">Could not load sync status: {(status.error as Error).message}</span>
        <button className="link" onClick={() => status.refetch()}>Retry</button>
      </section>
    );
  }
  const s = status.data!;
  const job = s.latest;
  const running = job?.status === 'running' || job?.status === 'pending';

  return (
    <section className="card sync" aria-live="polite">
      <div className="sync-main">
        <div className="sync-state">
          {running && <span className="spinner" aria-hidden="true" />}
          <strong>
            {!job && 'Waiting for the first sync to start…'}
            {job && running && `${job.type === 'full' ? 'Importing' : 'Updating'} contacts`}
            {job?.status === 'completed' && 'Contacts are up to date'}
            {job?.status === 'failed' && 'Sync stopped'}
          </strong>
        </div>
        <span className="muted">
          {s.contacts.toLocaleString()} contacts stored
          {job && ` · ${job.pages} pages fetched`}
          {job?.finished_at && ` · finished ${ago(job.finished_at)}`}
        </span>
      </div>

      <div className="sync-notes">
        <span title="Notes delivered to HubSpot">{s.notes.synced} notes synced</span>
        {s.notes.pending + s.notes.syncing > 0 && <span className="pill muted">{s.notes.pending + s.notes.syncing} sending</span>}
        {s.notes.failed > 0 && <span className="pill bad">{s.notes.failed} failed</span>}
      </div>

      {job?.status === 'failed' && (
        <div className="banner error inline" role="alert">
          <span>{job.last_error ?? 'The sync ran out of retries.'} It will continue from where it stopped.</span>
          <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Resuming…' : 'Resume sync'}
          </button>
        </div>
      )}
      {retry.isError && <span className="error-text">{(retry.error as Error).message}</span>}
    </section>
  );
}
