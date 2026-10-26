import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Skeleton } from './Skeleton';
import { useToast } from './Toast';

const ago = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

export function SyncActivityView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.syncStatus,
    refetchInterval: 3000,
  });

  const retry = useMutation({
    mutationFn: api.retrySync,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sync-status'] });
      toast(res.resumed ? 'Sync resumed from its last checkpoint.' : 'A new sync was started.', 'ok');
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });

  if (status.isLoading) {
    return (
      <div className="activity-skeleton" aria-label="Loading sync activity">
        <div className="card sync-card">
          <Skeleton className="skeleton-line w40" />
          <Skeleton className="skeleton-line w60" />
        </div>
        <div className="dashboard-grid">
          {[0, 1].map((i) => (
            <div className="card dashboard-panel" key={i}>
              <Skeleton className="skeleton-line w40" />
              <Skeleton className="skeleton-value" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="card" style={{ padding: '2rem' }}>
        <div className="error-text" style={{ marginBottom: '1rem' }}>Could not load sync status: {(status.error as Error).message}</div>
        <button className="btn primary" onClick={() => status.refetch()}>Retry</button>
      </div>
    );
  }

  const s = status.data!;
  const job = s.latest;
  const running = job?.status === 'running' || job?.status === 'pending';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="card sync-card" aria-live="polite">
        <div className="sync-status-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {running && <div className="spinner" aria-hidden="true" />}
            {!running && job?.status === 'completed' && <CheckCircle2 size={20} style={{ color: 'var(--ok)' }} />}
            {!running && job?.status === 'failed' && <AlertTriangle size={20} style={{ color: 'var(--bad)' }} />}
            <div>
              <h3 style={{ fontSize: '1.05rem' }}>
                {!job && 'Waiting for the first sync to start…'}
                {job && running && `${job.type === 'full' ? 'Importing' : 'Updating'} contacts from HubSpot`}
                {job?.status === 'completed' && 'Sync completed successfully'}
                {job?.status === 'failed' && 'Sync paused due to error'}
              </h3>
              <p className="muted small" style={{ marginTop: '0.2rem' }}>
                {s.contacts.toLocaleString()} total contacts stored in PostgreSQL
                {job && ` · ${job.pages} pages fetched`}
                {job?.finished_at && ` · Finished ${ago(job.finished_at)}`}
              </p>
            </div>
          </div>

          {job?.status === 'failed' && (
            <button className="btn primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? 'Resuming…' : 'Resume Sync'}
            </button>
          )}
        </div>

        {running && (
          <div className="sync-progress" role="progressbar" aria-label="Sync in progress">
            <span />
          </div>
        )}

        {job?.status === 'failed' && job.last_error && (
          <div className="banner error" style={{ margin: '0.5rem 0 0' }}>
            <span>{job.last_error}</span>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Notes Delivery Pipeline</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Synced</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--ok)' }}>{s.notes.synced}</div>
            </div>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Pending / Sending</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{s.notes.pending + s.notes.syncing}</div>
            </div>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Failed</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: s.notes.failed > 0 ? 'var(--bad)' : 'inherit' }}>{s.notes.failed}</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>BullMQ Queue Health</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Waiting</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{s.queue.waiting}</div>
            </div>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Active</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{s.queue.active}</div>
            </div>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Delayed (Rate limit)</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{s.queue.delayed}</div>
            </div>
            <div style={{ background: 'var(--border-subtle)', padding: '1rem', borderRadius: '8px' }}>
              <div className="muted small">Failed</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: s.queue.failed > 0 ? 'var(--bad)' : 'inherit' }}>{s.queue.failed}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
