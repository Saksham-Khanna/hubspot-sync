import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ContactDetailPanel } from './ContactDetail';
import { Search } from 'lucide-react';

export function NotesView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const contactsQuery = useQuery({
    queryKey: ['contacts-for-notes', search],
    queryFn: () => api.contacts({ search, page: 1, pageSize: 25 }),
  });

  return (
    <div className="contacts-layout">
      <div className="card list-panel">
        <div className="list-search">
          <Search size={16} className="muted" />
          <input
            type="search"
            placeholder="Search contact for notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {contactsQuery.isLoading && <p className="muted pad">Loading contacts…</p>}
        {contactsQuery.isError && (
          <div className="banner error inline" role="alert">
            <span>Could not load contacts: {(contactsQuery.error as Error).message}</span>
            <button className="link" type="button" onClick={() => contactsQuery.refetch()}>Retry</button>
          </div>
        )}
        <ul className="rows-container">
          {contactsQuery.data?.data.map((c) => {
            const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed contact';
            return (
              <li key={c.id}>
                <button
                  className={`contact-row ${selectedId === c.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className="contact-name">{name}</span>
                  <span className="contact-sub">{c.email ?? 'No email'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card" style={{ minHeight: '500px' }}>
        <ContactDetailPanel contactId={selectedId} />
      </div>
    </div>
  );
}
