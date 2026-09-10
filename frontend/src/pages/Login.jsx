import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { APP_NAME } from '../api/client.js';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(form);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-brand">{APP_NAME}</h1>
        <h2>Sign in</h2>
        <ErrorBanner error={error} />
        <form onSubmit={onSubmit}>
          <label>
            Email
            <input type="email" required value={form.email} onChange={update('email')} autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              value={form.password}
              onChange={update('password')}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="auth-switch">
          New to {APP_NAME}? <Link to="/register">Create an account</Link>
        </p>
        <p className="auth-hint">
          Demo account: <code>demo@streamflix.local</code> / <code>Demo@12345</code>
          <br />
          Admin: <code>admin@streamflix.local</code> / <code>Admin@12345</code>
        </p>
      </div>
    </div>
  );
}
