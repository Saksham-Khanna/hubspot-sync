import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, AuthStatus, SyncStatus } from '../lib/api';
import { Users, FileText, Activity, RefreshCw, ArrowRight } from 'lucide-react';
import { Skeleton } from './Skeleton';
import { useToast } from './Toast';

interface OverviewViewProps {
  auth?: AuthStatus;
  onNavigate: (tab: 'contacts' | 'activity' | 'notes' | 'settings') => void;
}

const ago = (iso: string | null) => {
  if (!iso) return 'Never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  return `${Math.floor(s / 86400)} days ago`;
};

export function OverviewView({ auth, onNavigate }: OverviewViewProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const syncQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.syncStatus,
    enabled: !!auth?.connected || !!auth?.needsReauth,
    refetchInterval: 5000,
  });

  const retrySync = useMutation({
    mutationFn: api.retrySync,
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sync-status'] });
      toast(res.resumed ? 'Sync resumed from its last checkpoint.' : 'A new sync was started.', 'ok');
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });

  const connected = auth?.connected || auth?.needsReauth;

  if (!connected) {
    return (
      <div className="empty-hero">
        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--primary-subtle)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
          <Activity size={24} />
        </div>
        <h2>Connect HubSpot to get started</h2>
        <p>HubSpot Sync connects securely to your portal via OAuth, automatically imports your contacts, keeps them fresh in real time, and pushes notes back to HubSpot.</p>
        <a className="btn primary large" href="/api/auth/hubspot/start">
          Connect HubSpot Account
        </a>
      </div>
    );
  }

  const s: SyncStatus | undefined = syncQuery.data;
  const job = s?.latest;
  const notes = s?.notes ?? { pending: 0, syncing: 0, synced: 0, failed: 0 };
  const queue = s?.queue ?? { waiting: 0, active: 0, delayed: 0, failed: 0 };
  const loading = syncQuery.isLoading;
  const running = job?.status === 'running' || job?.status === 'pending';
  const statusLabel = !job ? 'Waiting' : running ? 'Syncing…' : job.status === 'completed' ? 'Up to date' : 'Stopped';
  const statusTone = job?.status === 'failed' ? 'bad' : running ? 'warn' : job?.status === 'completed' ? 'ok' : 'muted';
  const queueDepth = queue.waiting + queue.active + queue.delayed;

  return (
    <div>
      {auth?.needsReauth && (
        <div className="banner warn">
          <span>HubSpot authorization has expired. Reconnect your account to resume syncing. Your existing synced data is preserved.</span>
          <a className="btn primary" href="/api/auth/hubspot/start">Reconnect HubSpot</a>
        </div>
      )}

      {job?.status === 'failed' && (
        <div className="banner error">
          <span>Sync encountered an error: {job.last_error ?? 'Max retries exceeded'}. It can be resumed from its last checkpoint.</span>
          <button className="btn" onClick={() => retrySync.mutate()} disabled={retrySync.isPending}>
            {retrySync.isPending ? 'Resuming…' : 'Resume Sync'}
          </button>
        </div>
      )}

      {running && (
        <div className="sync-progress" role="progressbar" aria-label="Sync in progress">
          <span />
        </div>
      )}

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span>Synced Contacts</span>
            <span className="metric-icon primary"><Users size={16} /></span>
          </div>
          {loading ? <Skeleton className="skeleton-value" /> : <div className="metric-value">{s?.contacts.toLocaleString() ?? '—'}</div>}
          {loading ? <Skeleton className="skeleton-line w60" /> : <div className="metric-footer">Stored in PostgreSQL</div>}
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Notes Delivered</span>
            <span className="metric-icon ok"><FileText size={16} /></span>
          </div>
          {loading ? <Skeleton className="skeleton-value" /> : <div className="metric-value">{notes.synced.toLocaleString()}</div>}
          {loading ? <Skeleton className="skeleton-line w60" /> : (
            <div className="metric-footer">
              {notes.failed > 0 ? <span className="error-text">{notes.failed} failed</span> : 'All delivered successfully'}
            </div>
          )}
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Sync Status</span>
            <span className={`metric-icon ${statusTone}`}><Activity size={16} /></span>
          </div>
          {loading ? <Skeleton className="skeleton-value" /> : (
            <div className={`metric-value status-value ${statusTone}`}>
              <span className={`status-dot ${statusTone}`} />
              {statusLabel}
            </div>
          )}
          {loading ? <Skeleton className="skeleton-line w60" /> : (
            <div className="metric-footer">
              {job?.finished_at ? `Completed ${ago(job.finished_at)}` : job?.status === 'running' ? `${job.pages} pages fetched` : 'Idle'}
            </div>
          )}
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Queue Depth</span>
            <span className={`metric-icon ${queueDepth > 0 ? 'warn' : 'muted'}`}><RefreshCw size={16} /></span>
          </div>
          {loading ? <Skeleton className="skeleton-value" /> : <div className="metric-value">{queueDepth}</div>}
          {loading ? <Skeleton className="skeleton-line w60" /> : (
            <div className="metric-footer">
              {queue.failed > 0 ? <span className="error-text">{queue.failed} failed jobs in queue</span> : 'No failed jobs in queue'}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card dashboard-panel">
          <h3 className="panel-title">Quick Navigation</h3>
          <div className="quick-actions">
            <button className="btn quick-btn" onClick={() => onNavigate('contacts')}>
              <span><Users size={16} /> Browse Synced Contacts</span>
              <ArrowRight size={16} className="muted" />
            </button>
            <button className="btn quick-btn" onClick={() => onNavigate('activity')}>
              <span><Activity size={16} /> View Sync Activity & Queue</span>
              <ArrowRight size={16} className="muted" />
            </button>
            <button className="btn quick-btn" onClick={() => onNavigate('notes')}>
              <span><FileText size={16} /> Manage Contact Notes</span>
              <ArrowRight size={16} className="muted" />
            </button>
          </div>
        </div>

        <div className="card dashboard-panel">
          <h3 className="panel-title">Portal Information</h3>
          <dl className="fields portal-fields">
            <div>
              <dt>HubSpot Portal ID</dt>
              <dd>{auth?.hubId ?? '—'}</dd>
            </div>
            <div>
              <dt>Portal Domain</dt>
              <dd>{auth?.hubDomain ?? 'Not specified'}</dd>
            </div>
            <div>
              <dt>User Email</dt>
              <dd>{auth?.userEmail ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
