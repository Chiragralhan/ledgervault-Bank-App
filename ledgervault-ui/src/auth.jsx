import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as apiModule from './api';

// Holds "who is logged in" for the whole app, so any page can read it.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const s = apiModule.getSession();
    return s ? s.user : null;
  });
  const [checking, setChecking] = useState(() => !!apiModule.getSession());

  // On first load, if a session is stored, confirm it with the server.
  useEffect(() => {
    if (!apiModule.getSession()) return;
    apiModule
      .fetchMe()
      .then((me) => setUser(me))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  // If the refresh token is rejected anywhere, drop back to logged-out.
  useEffect(() => apiModule.onSessionEnded(() => setUser(null)), []);

  const login = useCallback(async (email, password) => {
    setUser(await apiModule.login(email, password));
  }, []);

  const register = useCallback(async (name, email, password) => {
    setUser(await apiModule.register(name, email, password));
  }, []);

  const logout = useCallback(async () => {
    await apiModule.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, checking, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}