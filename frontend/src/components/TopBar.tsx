import React from 'react';
import { AuthStatus } from '../lib/api';
import { LogOut, Menu } from 'lucide-react';

interface TopBarProps {
  title: string;
  auth?: AuthStatus;
  isLoadingAuth: boolean;
  isAuthError: boolean;
  onDisconnect: () => void;
  isDisconnecting: boolean;
  navOpen: boolean;
  onMenuClick: () => void;
}

export function TopBar({
  title,
  auth,
  isLoadingAuth,
  isAuthError,
  onDisconnect,
  isDisconnecting,
  navOpen,
  onMenuClick,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-btn menu-btn"
          type="button"
          onClick={onMenuClick}
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-controls="app-sidebar"
          aria-expanded={navOpen}
        >
          <Menu size={20} />
        </button>
        <h1 className="topbar-title">{title}</h1>
      </div>
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
        {!auth?.connected && !isLoadingAuth && (
          <a className="btn primary" href="/api/auth/hubspot/start">
            Connect HubSpot
          </a>
        )}
      </div>
    </header>
  );
}
