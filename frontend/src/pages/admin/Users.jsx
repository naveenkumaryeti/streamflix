import { useEffect, useState } from 'react';
import * as adminApi from '../../api/admin.js';
import { useAuth } from '../../context/AuthContext.jsx';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

export default function Users() {
  const { user: me } = useAuth();
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    adminApi
      .listUsers({ search, page, limit: 20 })
      .then((data) => {
        setItems(data.items);
        setMeta(data.meta);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  const toggleStatus = async (u) => {
    setBusyId(u.id);
    try {
      await adminApi.setUserStatus(u.id, u.status === 'active' ? 'suspended' : 'active');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const toggleRole = async (u) => {
    setBusyId(u.id);
    try {
      await adminApi.setUserRole(u.id, u.role === 'admin' ? 'user' : 'admin');
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h1 className="page__heading">Users</h1>
      <form className="filter-bar" onSubmit={onSearchSubmit}>
        <input placeholder="Search by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="submit" className="btn btn--ghost">
          Search
        </button>
      </form>

      <ErrorBanner error={error} onRetry={load} />
      {loading && <Loader label="Loading users…" />}

      {items && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td>{u.fullName}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  <span className={`status status--${u.status}`}>{u.status}</span>
                </td>
                <td className="table__actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => toggleStatus(u)}
                    disabled={busyId === u.id || u.id === me?.id}
                  >
                    {u.status === 'active' ? 'Suspend' : 'Reactivate'}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => toggleRole(u)}
                    disabled={busyId === u.id || u.id === me?.id}
                  >
                    {u.role === 'admin' ? 'Revoke admin' : 'Make admin'}
                  </button>
                </td>
              </tr>
            ))}
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
