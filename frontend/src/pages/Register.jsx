import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { APP_NAME } from '../api/client.js';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(form);
      navigate('/', { replace: true });
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
        <h2>Create your account</h2>
        <ErrorBanner error={error} />
        <form onSubmit={onSubmit}>
          <label>
            Full name
            <input required value={form.fullName} onChange={update('fullName')} autoComplete="name" />
          </label>
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
              autoComplete="new-password"
            />
          </label>
          <p className="field-hint">At least 8 characters, with a mix of letters and numbers.</p>
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
