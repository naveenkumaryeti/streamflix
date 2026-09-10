import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import * as usersApi from '../api/users.js';
import * as authApi from '../api/auth.js';
import ErrorBanner from '../components/ErrorBanner.jsx';
import Loader from '../components/Loader.jsx';

export default function Account() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState({ fullName: user?.fullName || '', email: user?.email || '' });
  const [profileError, setProfileError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '' });
  const [pwError, setPwError] = useState(null);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  const [sessions, setSessions] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);

  useEffect(() => {
    authApi
      .sessions()
      .then((data) => setSessions(data.items))
      .catch(() => setSessions([]));
  }, []);

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileError(null);
    setProfileSaved(false);
    setProfileSaving(true);
    try {
      const { user: updated } = await usersApi.updateProfile(profile);
      setUser(updated);
      setProfileSaved(true);
    } catch (err) {
      setProfileError(err);
    } finally {
      setProfileSaving(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError(null);
    setPwDone(false);
    setPwSaving(true);
    try {
      await authApi.changePassword(pwForm);
      setPwForm({ currentPassword: '', newPassword: '' });
      setPwDone(true);
    } catch (err) {
      setPwError(err);
    } finally {
      setPwSaving(false);
    }
  };

  const closeAccount = async () => {
    setClosing(true);
    setCloseError(null);
    try {
      await usersApi.closeAccount();
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setCloseError(err);
      setClosing(false);
    }
  };

  return (
    <div className="page page--narrow">
      <h1 className="page__heading">Account</h1>

      <section className="panel">
        <h2>Profile</h2>
        <ErrorBanner error={profileError} />
        {profileSaved && <p className="notice notice--success">Saved.</p>}
        <form onSubmit={saveProfile}>
          <label>
            Full name
            <input
              value={profile.fullName}
              onChange={(e) => setProfile((p) => ({ ...p, fullName: e.target.value }))}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={profile.email}
              onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={profileSaving}>
            {profileSaving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Change password</h2>
        <ErrorBanner error={pwError} />
        {pwDone && <p className="notice notice--success">Password updated. Other devices were signed out.</p>}
        <form onSubmit={changePassword}>
          <label>
            Current password
            <input
              type="password"
              required
              value={pwForm.currentPassword}
              onChange={(e) => setPwForm((f) => ({ ...f, currentPassword: e.target.value }))}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              required
              value={pwForm.newPassword}
              onChange={(e) => setPwForm((f) => ({ ...f, newPassword: e.target.value }))}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={pwSaving}>
            {pwSaving ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2>Active sessions</h2>
        {sessions === null && <Loader label="Loading sessions…" />}
        {sessions && sessions.length === 0 && <p className="empty-state">No other active sessions.</p>}
        {sessions && sessions.length > 0 && (
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <span>{s.userAgent || 'Unknown device'}</span>
                <span className="session-list__meta">{s.ip}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel panel--danger">
        <h2>Close account</h2>
        <p>This permanently deactivates your account and cancels any active subscription.</p>
        <ErrorBanner error={closeError} />
        {!closeConfirm ? (
          <button type="button" className="btn btn--danger" onClick={() => setCloseConfirm(true)}>
            Close my account
          </button>
        ) : (
          <div className="confirm-row">
            <span>Are you sure? This cannot be undone.</span>
            <button type="button" className="btn btn--danger" onClick={closeAccount} disabled={closing}>
              {closing ? 'Closing…' : 'Yes, close it'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setCloseConfirm(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
