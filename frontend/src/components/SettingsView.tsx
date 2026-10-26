import React from 'react';
import { AuthStatus } from '../lib/api';
import { CheckCircle2, AlertTriangle, ShieldCheck, LogOut } from 'lucide-react';

interface SettingsViewProps {
  auth?: AuthStatus;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}

export function SettingsView({ auth, onDisconnect, isDisconnecting }: SettingsViewProps) {
  const connected = auth?.connected;
  const needsReauth = auth?.needsReauth;

  return (
    <div style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div className="card" style={{ padding: '2rem' }}>
        <h3 style={{ fontSize: '1.15rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={20} className="primary" /> HubSpot OAuth Integration
        </h3>
        <p className="muted" style={{ marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          Connect your HubSpot portal via OAuth 2.0. Tokens are encrypted at rest with AES-256-GCM.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.25rem', background: 'var(--border-subtle)', borderRadius: '8px', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 500 }}>Connection Status</span>
            {connected && <span className="pill ok"><CheckCircle2 size={14} /> Connected</span>}
            {needsReauth && <span className="pill warn"><AlertTriangle size={14} /> Reauth Required</span>}
            {auth && !connected && !needsReauth && <span className="pill">Disconnected</span>}
          </div>

          {auth?.hubId && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">Portal ID</span>
              <span style={{ fontWeight: 600 }}>{auth.hubId}</span>
            </div>
          )}
          {auth?.hubDomain && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">HubSpot Domain</span>
              <span style={{ fontWeight: 600 }}>{auth.hubDomain}</span>
            </div>
          )}
          {auth?.userEmail && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">Connected User</span>
              <span style={{ fontWeight: 600 }}>{auth.userEmail}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {(!connected || needsReauth) && (
            <a className="btn primary" href="/api/auth/hubspot/start">
              {needsReauth ? 'Reconnect HubSpot' : 'Connect HubSpot Account'}
            </a>
          )}
          {connected && (
            <button className="btn danger" onClick={onDisconnect} disabled={isDisconnecting}>
              <LogOut size={16} />
              {isDisconnecting ? 'Disconnecting…' : 'Disconnect Portal'}
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: '2rem' }}>
        <h3 style={{ fontSize: '1.15rem', marginBottom: '0.5rem' }}>Security & Scopes</h3>
        <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
          This app requests read access to contacts (`crm.objects.contacts.read`) and write access to contacts & notes (`crm.objects.contacts.write`).
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className="pill primary">oauth</span>
          <span className="pill primary">crm.objects.contacts.read</span>
          <span className="pill primary">crm.objects.contacts.write</span>
        </div>
      </div>
    </div>
  );
}
