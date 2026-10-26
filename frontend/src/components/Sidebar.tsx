import React from 'react';
import { LayoutDashboard, Users, Activity, FileText, Settings, CheckCircle2, AlertTriangle } from 'lucide-react';
import { AuthStatus } from '../lib/api';

export type TabType = 'overview' | 'contacts' | 'activity' | 'notes' | 'settings';

interface SidebarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  authData?: AuthStatus;
}

export function Sidebar({ activeTab, onTabChange, authData }: SidebarProps) {
  const isConnected = authData?.connected;
  const needsReauth = authData?.needsReauth;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo-icon">HS</div>
        <div>
          <div className="logo-text">HubSpot Sync</div>
          <div className="small muted">CRM Integration</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <button
          className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => onTabChange('overview')}
        >
          <LayoutDashboard size={18} />
          Overview
        </button>
        <button
          className={`nav-item ${activeTab === 'contacts' ? 'active' : ''}`}
          onClick={() => onTabChange('contacts')}
        >
          <Users size={18} />
          Contacts
        </button>
        <button
          className={`nav-item ${activeTab === 'activity' ? 'active' : ''}`}
          onClick={() => onTabChange('activity')}
        >
          <Activity size={18} />
          Sync Activity
        </button>
        <button
          className={`nav-item ${activeTab === 'notes' ? 'active' : ''}`}
          onClick={() => onTabChange('notes')}
        >
          <FileText size={18} />
          Notes
        </button>
        <button
          className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => onTabChange('settings')}
        >
          <Settings size={18} />
          Settings
        </button>
      </nav>

      <div className="sidebar-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
          {isConnected ? (
            <span className="pill ok" style={{ fontSize: '0.7rem' }}>
              <CheckCircle2 size={12} /> Connected
            </span>
          ) : needsReauth ? (
            <span className="pill warn" style={{ fontSize: '0.7rem' }}>
              <AlertTriangle size={12} /> Reauth Required
            </span>
          ) : (
            <span className="pill" style={{ fontSize: '0.7rem' }}>Disconnected</span>
          )}
        </div>
        {authData?.hubDomain && <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{authData.hubDomain}</div>}
      </div>
    </aside>
  );
}
