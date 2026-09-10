import { useEffect, useState } from 'react';
import * as adminApi from '../../api/admin.js';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

export default function Audit() {
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    adminApi
      .listAudit({ action, page, limit: 40 })
      .then((data) => {
        setItems(data.items);
        setMeta(data.meta);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  return (
    <div>
      <h1 className="page__heading">Audit log</h1>
      <form className="filter-bar" onSubmit={onSubmit}>
        <input placeholder="Filter by action prefix, e.g. title." value={action} onChange={(e) => setAction(e.target.value)} />
        <button type="submit" className="btn btn--ghost">
          Filter
        </button>
      </form>

      <ErrorBanner error={error} onRetry={load} />
      {loading && <Loader label="Loading audit log…" />}

      {items && (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>{entry.actorEmail || entry.actorId || 'system'}</td>
                <td>
                  <code>{entry.action}</code>
                </td>
                <td>
                  {entry.entityType ? `${entry.entityType}:${entry.entityId?.slice?.(0, 8) ?? entry.entityId}` : ''}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-state">
                  No matching entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="pagination">
          <button type="button" disabled={!meta.hasPreviousPage} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span>
            Page {meta.page} of {meta.totalPages}
          </span>
          <button type="button" disabled={!meta.hasNextPage} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
