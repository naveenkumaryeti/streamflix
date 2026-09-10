import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as adminApi from '../../api/admin.js';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

const STATUSES = ['draft', 'uploading', 'processing', 'ready', 'published', 'failed', 'archived'];

export default function Titles() {
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    adminApi
      .listTitles({ search, status, page, limit: 20 })
      .then((data) => {
        setItems(data.items);
        setMeta(data.meta);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [status, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  const publish = async (id) => {
    setBusyId(id);
    try {
      await adminApi.publishTitle(id);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const unpublish = async (id) => {
    setBusyId(id);
    try {
      await adminApi.unpublishTitle(id);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this title and its media assets? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await adminApi.deleteTitle(id);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="page__heading">Titles</h1>
        <Link to="/admin/titles/new" className="btn btn--primary">
          + New title
        </Link>
      </div>

      <form className="filter-bar" onSubmit={onSearchSubmit}>
        <input
          placeholder="Search titles…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn--ghost">
          Search
        </button>
      </form>

      <ErrorBanner error={error} onRetry={load} />
      {loading && <Loader label="Loading titles…" />}

      {items && (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
              <th>Year</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/admin/titles/${t.id}`}>{t.title}</Link>
                </td>
                <td>{t.type}</td>
                <td>
                  <span className={`status status--${t.status}`}>{t.status}</span>
                </td>
                <td>{t.releaseYear}</td>
                <td className="table__actions">
                  {t.status === 'published' ? (
                    <button type="button" className="link-btn" onClick={() => unpublish(t.id)} disabled={busyId === t.id}>
                      Unpublish
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => publish(t.id)}
                      disabled={busyId === t.id || t.status !== 'ready'}
                      title={t.status !== 'ready' ? 'Needs a processed video before it can publish' : ''}
                    >
                      Publish
                    </button>
                  )}
                  <button type="button" className="link-btn link-btn--danger" onClick={() => remove(t.id)} disabled={busyId === t.id}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-state">
                  No titles match.
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
