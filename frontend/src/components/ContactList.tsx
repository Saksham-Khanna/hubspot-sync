import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, fullName } from '../lib/api';

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const PAGE_SIZE = 25;

export function ContactList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const [input, setInput] = useState('');
  const search = useDebounced(input.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search]);

  const q = useQuery({
    queryKey: ['contacts', search, page],
    queryFn: () => api.contacts({ search, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    refetchInterval: 5000, // new contacts appear while the import is running
  });
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card list">
      <div className="list-head">
        <h2>Contacts{q.data && <span className="count">{total.toLocaleString()}</span>}</h2>
        <input
          type="search"
          placeholder="Search name, email or company"
          aria-label="Search contacts"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>

      {q.isLoading && <p className="muted pad">Loading contacts…</p>}
      {q.isError && (
        <div className="banner error inline" role="alert">
          <span>Could not load contacts: {(q.error as Error).message}</span>
          <button className="link" onClick={() => q.refetch()}>Retry</button>
        </div>
      )}
      {q.data && q.data.data.length === 0 && (
        <p className="muted pad">{search ? `No contacts match “${search}”.` : 'No contacts yet. They appear here as the sync fetches them.'}</p>
      )}

      <ul className={`rows ${q.isPlaceholderData ? 'stale' : ''}`}>
        {q.data?.data.map((c) => (
          <li key={c.id}>
            <button className={`row ${c.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(c.id)}>
              <span className="row-name">{fullName(c)}</span>
              <span className="row-sub">{[c.email, c.company].filter(Boolean).join(' · ') || 'No email or company'}</span>
            </button>
          </li>
        ))}
      </ul>

      {total > PAGE_SIZE && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}
