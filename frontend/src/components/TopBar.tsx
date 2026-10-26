import React from 'react';
import { AuthStatus } from '../lib/api';
import { LogOut } from 'lucide-react';

interface TopBarProps {
  title: string;
  auth?: AuthStatus;
  isLoadingAuth: boolean;
  isAuthError: boolean;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}

export function TopBar({ title, auth, isLoadingAuth, isAuthError, onDisconnect, isDisconnecting }: TopBarProps) {
  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-actions">
        {isLoadingAuth && <span className="pill muted">Checking connection…</span>}
        {isAuthError && <span className="pill bad">Server unreachable</span>}
        {auth?.connected && (
          <>
            <span className="pill ok">
              Connected{auth.hubDomain ? ` (${auth.hubDomain})` : ''}
            </span>
            <button className="btn" onClick={onDisconnect} disabled={isDisconnecting}>
              <LogOut size={14} />
              {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        )}
        {auth?.needsReauth && (
          <span className="pill warn">Authorization Expired</span>
        )}
        {auth && !auth.connected && (
          <a className="btn primary" href="/api/auth/hubspot/start">
            Connect HubSpot
          </a>
        )}
      </div>
    </header>
  );
}
