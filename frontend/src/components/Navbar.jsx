import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { APP_NAME } from '../api/client.js';

export default function Navbar() {
  const { user, isAuthenticated, isAdmin, logout } = useAuth();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  const submitSearch = (e) => {
    e.preventDefault();
    if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  };

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login');
  };

  return (
    <header className="navbar">
      <div className="navbar__left">
        <Link to="/" className="navbar__brand">
          {APP_NAME}
        </Link>
        {isAuthenticated && (
          <nav className="navbar__links">
            <Link to="/">Home</Link>
            <Link to="/my-list">My List</Link>
            {isAdmin && <Link to="/admin">Admin</Link>}
          </nav>
        )}
      </div>

      <div className="navbar__right">
        {isAuthenticated && (
          <form className="navbar__search" onSubmit={submitSearch}>
            <input
              type="search"
              placeholder="Titles, genres…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search titles"
            />
            <button type="submit" aria-label="Search">
              🔍
            </button>
          </form>
        )}

        {isAuthenticated ? (
          <div className="navbar__account">
            <button type="button" className="navbar__avatar" onClick={() => setMenuOpen((v) => !v)}>
              {(user?.fullName || user?.email || '?').charAt(0).toUpperCase()}
            </button>
            {menuOpen && (
              <div className="navbar__menu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="navbar__menu-name">{user?.fullName || user?.email}</div>
                <Link to="/account" onClick={() => setMenuOpen(false)}>
                  Account
                </Link>
                <Link to="/subscription" onClick={() => setMenuOpen(false)}>
                  Subscription
                </Link>
                <button type="button" onClick={handleLogout}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link to="/login" className="btn btn--primary btn--sm">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
