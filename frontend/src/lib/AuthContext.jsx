import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import { api, setUnauthenticatedHandler } from '@/api/client';

/**
 * Authentication state, backed by our own session API.
 *
 * The exported surface is deliberately unchanged from the Base44 version -
 * `isLoadingAuth`, `authChecked`, `authError`, `checkUserAuth`,
 * `navigateToLogin` and the rest - so App.jsx, ProtectedRoute.jsx and
 * JobProgressSync.jsx continue to work without edits. Swapping the backend and
 * reshaping the context in one change would make the diff unreviewable.
 *
 * What actually changed underneath:
 *   * the session is an httpOnly cookie the browser sends automatically, so
 *     there is no token to read, store, or accidentally log (D18);
 *   * there is no "app public settings" call - that was a Base44 concept.
 *     `isLoadingPublicSettings` survives as a constant `false` purely so
 *     App.jsx keeps its existing loading condition.
 */
const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState(null);

  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true);
    try {
      const me = await api.auth.me();
      if (me) {
        setUser(me);
        setIsAuthenticated(true);
        setAuthError(null);
      } else {
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'auth_required', message: 'Authentication required' });
      }
    } catch (err) {
      // A network or server failure is NOT "signed out". Treating it as such
      // would bounce the user to /login on a blip and lose their work.
      console.error('Auth check failed:', err);
      setUser(null);
      setIsAuthenticated(false);
      setAuthError({ type: 'unknown', message: err.message || 'Could not reach the server' });
    } finally {
      setIsLoadingAuth(false);
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    checkUserAuth();
  }, [checkUserAuth]);

  // Any 401 from any request means the session ended - expired, revoked, or the
  // server restarted. Handled centrally so a stale session surfaces once rather
  // than as a dozen simultaneous query failures.
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setIsLoadingAuth(false);
      setAuthError({ type: 'auth_required', message: 'Session expired' });
    });
    return () => setUnauthenticatedHandler(null);
  }, []);

  const login = useCallback(async (email, password, totp) => {
    const res = await api.auth.login(email, password, totp);
    setUser(res.user);
    setIsAuthenticated(true);
    setAuthError(null);
    setAuthChecked(true);
    return res;
  }, []);

  const logout = useCallback(async () => {
    setUser(null);
    setIsAuthenticated(false);
    await api.auth.logout(); // redirects to /login
  }, []);

  const navigateToLogin = useCallback(() => {
    api.auth.redirectToLogin();
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      // Vestigial: kept so App.jsx's loading condition needs no edit.
      isLoadingPublicSettings: false,
      appPublicSettings: null,
      authError,
      authChecked,
      login,
      logout,
      navigateToLogin,
      checkUserAuth,
      // Base44 had a separate app-level check; both now mean the same thing.
      checkAppState: checkUserAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
