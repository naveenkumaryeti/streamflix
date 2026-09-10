import { NavLink, Outlet } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { APP_NAME } from '../../api/client.js';

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-sidebar__brand">{APP_NAME} Admin</div>
        <nav>
          <NavLink to="/admin" end>
            Dashboard
          </NavLink>
          <NavLink to="/admin/titles">Titles</NavLink>
          <NavLink to="/admin/users">Users</NavLink>
          <NavLink to="/admin/payments">Payments</NavLink>
          <NavLink to="/admin/audit">Audit log</NavLink>
        </nav>
        <div className="admin-sidebar__footer">
          <NavLink to="/">← Back to app</NavLink>
          <div className="admin-sidebar__user">{user?.email}</div>
          <button type="button" className="link-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="admin-content">
        <Outlet />
      </main>
    </div>
  );
}
