import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { Sidebar, TabType } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewView } from './components/OverviewView';
import { ContactsView } from './components/ContactsView';
import { SyncActivityView } from './components/SyncActivityView';
import { NotesView } from './components/NotesView';
import { SettingsView } from './components/SettingsView';

const AUTH_ERRORS: Record<string, string> = {
  access_denied: 'You declined access in HubSpot. Connect again when you are ready.',
  invalid_state: 'The sign-in attempt expired or did not match. Try connecting again.',
  exchange_failed: 'HubSpot did not accept the authorization. Try connecting again.',
};

function useFlashFromUrl() {
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) setFlash({ kind: 'ok', text: 'HubSpot connected successfully. Your contacts are syncing now.' });
    const err = p.get('auth_error');
    if (err) setFlash({ kind: 'error', text: AUTH_ERRORS[err] ?? `HubSpot returned an error: ${err}` });
    if (p.size) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  return [flash, setFlash] as const;
}

export function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus });
  const [flash, setFlash] = useFlashFromUrl();
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const disconnect = useMutation({
    mutationFn: api.disconnect,
    onSuccess: () => {
      qc.clear();
      void qc.invalidateQueries({ queryKey: ['auth'] });
      setActiveTab('overview');
    },
  });

  const a = auth.data;

  const tabTitles: Record<TabType, string> = {
    overview: 'Overview',
    contacts: 'Contacts Directory',
    activity: 'Sync Activity & Queue',
    notes: 'Contact Notes',
    settings: 'Integration Settings',
  };

  return (
    <div className="app-layout">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} authData={a} />

      <div className="main-content">
        <TopBar
          title={tabTitles[activeTab]}
          auth={a}
          isLoadingAuth={auth.isLoading}
          isAuthError={auth.isError}
          onDisconnect={() => disconnect.mutate()}
          isDisconnecting={disconnect.isPending}
        />

        <main className="content-body">
          {flash && (
            <div className={`banner ${flash.kind}`} role="status">
              <span>{flash.text}</span>
              <button className="link" onClick={() => setFlash(null)}>Dismiss</button>
            </div>
          )}

          {auth.isError && (
            <div className="banner error" role="alert">
              <span>Could not connect to backend server: {(auth.error as Error).message}</span>
              <button className="link" onClick={() => auth.refetch()}>Retry</button>
            </div>
          )}

          {activeTab === 'overview' && <OverviewView auth={a} onNavigate={setActiveTab} />}
          {activeTab === 'settings' && <SettingsView auth={a} onDisconnect={() => disconnect.mutate()} isDisconnecting={disconnect.isPending} />}
          {activeTab !== 'overview' && activeTab !== 'settings' && a && !a.connected && !a.needsReauth && (
            <div className="empty-hero">
              <h2>Connect HubSpot first</h2>
              <p>Contacts, notes, and sync activity are available after the portal is connected. Nothing is fetched until then.</p>
              <a className="btn primary" href="/api/auth/hubspot/start">Connect HubSpot</a>
            </div>
          )}
          {activeTab === 'contacts' && (a?.connected || a?.needsReauth) && <ContactsView />}
          {activeTab === 'activity' && (a?.connected || a?.needsReauth) && <SyncActivityView />}
          {activeTab === 'notes' && (a?.connected || a?.needsReauth) && <NotesView />}
        </main>
      </div>
    </div>
  );
}
