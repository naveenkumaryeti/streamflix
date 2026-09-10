import { useEffect, useState } from 'react';
import * as adminApi from '../../api/admin.js';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

function money(cents, currency) {
  if (cents === undefined || cents === null) return '';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' }).format(cents / 100);
}

export default function Payments() {
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    adminApi
      .listPayments({ status, page, limit: 25 })
      .then((data) => {
        setItems(data.items);
        setMeta(data.meta);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [status, page]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h1 className="page__heading">Payments</h1>
      <div className="filter-bar">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
        </select>
      </div>

      <ErrorBanner error={error} onRetry={load} />
      {loading && <Loader label="Loading payments…" />}

      {items && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>User</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Provider</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.createdAt).toLocaleString()}</td>
                <td>{p.userEmail || p.userId}</td>
                <td>{money(p.amountCents, p.currency)}</td>
                <td>
                  <span className={`status status--${p.status}`}>{p.status}</span>
                </td>
                <td>{p.provider}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-state">
                  No payments match.
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
