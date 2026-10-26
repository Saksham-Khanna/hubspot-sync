import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, AuthStatus, SyncStatus } from '../lib/api';
import { Users, FileText, Activity, RefreshCw, ArrowRight } from 'lucide-react';

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
  const syncQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: api.syncStatus,
    enabled: !!auth?.connected || !!auth?.needsReauth,
    refetchInterval: 5000,
  });

  const retrySync = useMutation({
    mutationFn: api.retrySync,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-status'] }),
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

  const s = syncQuery.data;
  const job = s?.latest;
  const notes = s?.notes ?? { pending: 0, syncing: 0, synced: 0, failed: 0 };
  const queue = s?.queue ?? { waiting: 0, active: 0, delayed: 0, failed: 0 };

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

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span>Synced Contacts</span>
            <Users size={16} className="muted" />
          </div>
          <div className="metric-value">{s?.contacts?.toLocaleString() ?? '—'}</div>
          <div className="metric-footer">Stored in PostgreSQL</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Notes Delivered</span>
            <FileText size={16} className="muted" />
          </div>
          <div className="metric-value">{notes.synced.toLocaleString()}</div>
          <div className="metric-footer">
            {notes.failed > 0 ? <span className="error-text">{notes.failed} failed</span> : 'All delivered successfully'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Sync Status</span>
            <Activity size={16} className="muted" />
          </div>
          <div className="metric-value" style={{ fontSize: '1.25rem', marginTop: '0.25rem' }}>
            {!job ? 'Waiting' : job.status === 'running' || job.status === 'pending' ? 'Syncing…' : job.status === 'completed' ? 'Up to date' : 'Stopped'}
          </div>
          <div className="metric-footer">
            {job?.finished_at ? `Completed ${ago(job.finished_at)}` : job?.status === 'running' ? `${job.pages} pages fetched` : 'Idle'}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span>Queue Depth</span>
            <RefreshCw size={16} className="muted" />
          </div>
          <div className="metric-value">{queue.waiting + queue.active + queue.delayed}</div>
          <div className="metric-footer">{queue.failed} failed jobs in queue</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Quick Navigation</span>
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <button className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => onNavigate('contacts')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Users size={16} /> Browse Synced Contacts</span>
              <ArrowRight size={16} className="muted" />
            </button>
            <button className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => onNavigate('activity')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Activity size={16} /> View Sync Activity & Queue</span>
              <ArrowRight size={16} className="muted" />
            </button>
            <button className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => onNavigate('notes')}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileText size={16} /> Manage Contact Notes</span>
              <ArrowRight size={16} className="muted" />
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Portal Information</h3>
          <dl className="fields" style={{ margin: 0 }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>HubSpot Portal ID</dt>
              <dd style={{ fontWeight: 600 }}>{auth?.hubId ?? '—'}</dd>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Portal Domain</dt>
              <dd style={{ fontWeight: 600 }}>{auth?.hubDomain ?? 'Not specified'}</dd>
            </div>
            <div>
              <dt style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>User Email</dt>
              <dd style={{ fontWeight: 600 }}>{auth?.userEmail ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
