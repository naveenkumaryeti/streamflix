import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/auth.js';
import { onAuthLost, refreshSession } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [entitlement, setEntitlement] = useState(null);
  const [booting, setBooting] = useState(true);

  const clear = useCallback(() => {
    setUser(null);
    setEntitlement(null);
  }, []);

  useEffect(() => {
    onAuthLost(clear);
  }, [clear]);

  // On first paint, trade the httpOnly refresh cookie (if any) for a fresh access token so a
  // hard reload doesn't bounce a signed-in customer back to the login screen.
  useEffect(() => {
    (async () => {
      try {
        await refreshSession();
        const { user: freshUser, entitlement: freshEntitlement } = await authApi.me();
        setUser(freshUser);
        setEntitlement(freshEntitlement);
      } catch {
        clear();
      } finally {
        setBooting(false);
      }
    })();
  }, [clear]);

  const login = useCallback(async (credentials) => {
    const data = await authApi.login(credentials);
    setUser(data.user);
    setEntitlement(data.entitlement);
    return data;
  }, []);

  const register = useCallback(async (payload) => {
    const data = await authApi.register(payload);
    setUser(data.user);
    setEntitlement(data.entitlement);
    return data;
  }, []);

  const logout = useCallback(
    async (opts) => {
      await authApi.logout(opts).catch(() => {});
      clear();
    },
    [clear],
  );

  const refreshEntitlement = useCallback(async () => {
    const { entitlement: freshEntitlement, user: freshUser } = await authApi.me();
    setEntitlement(freshEntitlement);
    setUser(freshUser);
  }, []);

  const value = useMemo(
    () => ({
      user,
      entitlement,
      booting,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'admin',
      login,
      register,
      logout,
      refreshEntitlement,
      setUser,
    }),
    [user, entitlement, booting, login, register, logout, refreshEntitlement],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
