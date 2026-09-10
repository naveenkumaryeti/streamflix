import { Route, Routes } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import { ProtectedRoute, AdminRoute, GuestOnlyRoute } from './components/ProtectedRoute.jsx';

import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Search from './pages/Search.jsx';
import TitleDetail from './pages/TitleDetail.jsx';
import Watch from './pages/Watch.jsx';
import MyList from './pages/MyList.jsx';
import Account from './pages/Account.jsx';
import Subscription from './pages/Subscription.jsx';
import NotFound from './pages/NotFound.jsx';

import AdminLayout from './pages/admin/AdminLayout.jsx';
import AdminDashboard from './pages/admin/Dashboard.jsx';
import AdminTitles from './pages/admin/Titles.jsx';
import AdminTitleEditor from './pages/admin/TitleEditor.jsx';
import AdminUsers from './pages/admin/Users.jsx';
import AdminPayments from './pages/admin/Payments.jsx';
import AdminAudit from './pages/admin/Audit.jsx';

/**
 * The Watch page (video full-bleed) and admin section intentionally render without the
 * public Navbar — the admin shell has its own chrome (see AdminLayout), and a customer
 * mid-episode should never lose the frame to a nav bar they didn't ask for.
 */
function PublicLayout({ children }) {
  return (
    <>
      <Navbar />
      <main className="app-main">{children}</main>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<GuestOnlyRoute />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route
          path="/"
          element={
            <PublicLayout>
              <Home />
            </PublicLayout>
          }
        />
        <Route
          path="/search"
          element={
            <PublicLayout>
              <Search />
            </PublicLayout>
          }
        />
        <Route
          path="/title/:slug"
          element={
            <PublicLayout>
              <TitleDetail />
            </PublicLayout>
          }
        />
        <Route path="/watch/:titleId" element={<Watch />} />
        <Route
          path="/my-list"
          element={
            <PublicLayout>
              <MyList />
            </PublicLayout>
          }
        />
        <Route
          path="/account"
          element={
            <PublicLayout>
              <Account />
            </PublicLayout>
          }
        />
        <Route
          path="/subscription"
          element={
            <PublicLayout>
              <Subscription />
            </PublicLayout>
          }
        />
      </Route>

      <Route element={<AdminRoute />}>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="titles" element={<AdminTitles />} />
          <Route path="titles/new" element={<AdminTitleEditor />} />
          <Route path="titles/:id" element={<AdminTitleEditor />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="payments" element={<AdminPayments />} />
          <Route path="audit" element={<AdminAudit />} />
        </Route>
      </Route>

      <Route
        path="*"
        element={
          <PublicLayout>
            <NotFound />
          </PublicLayout>
        }
      />
    </Routes>
  );
}
