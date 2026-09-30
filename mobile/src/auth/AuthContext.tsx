import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  changePassword as apiChangePassword,
  forgotPassword as apiForgotPassword,
  getAuthConfig,
  getSession,
  loginUser,
  logoutServer,
  registerUser,
  resetPassword as apiResetPassword,
  sendVerificationCode,
  syncUser,
} from '../api/auth';
import { getAccessToken, setAccessToken, setAuthFailureHandler } from '../api/client';
import { AuthError, NetworkError } from '../api/errors';
import type { AuthConfigResponse, SessionUser } from '../api/types';
import {
  clearAllCredentials,
  getStoredProfile,
  getStoredToken,
  setStoredProfile,
  setStoredToken,
  type StoredProfile,
} from './storage';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: StoredProfile | null;
  /** Session payload from `/auth/session`, when restored. */
  session: SessionUser | null;
  /** Backend auth configuration; null until loaded (or when unreachable). */
  authConfig: AuthConfigResponse | null;
  /** Set when `/auth/config` could not be reached — drives the backend-error block. */
  configError: string | null;
  /** True while a login or auth submission attempt is in flight. */
  isSigningIn: boolean;
  /** Log in via standard email and password. */
  signInWithPassword: (input: { email: string; password: string }) => Promise<void>;
  /** Register a new account with email, code, and password. */
  register: (input: {
    email: string;
    password: string;
    code: string;
    displayName?: string | null;
  }) => Promise<void>;
  /** Send verification code for registration or password reset. */
  sendCode: (
    email: string,
    purpose: 'register' | 'reset_password',
  ) => Promise<{ success: boolean; message: string; delivery_mode: string }>;
  /** Reset forgotten password. */
  resetPassword: (input: { email: string; code: string; newPassword: string }) => Promise<void>;
  /** Change password for logged in user. */
  changePassword: (input: { oldPassword: string; newPassword: string }) => Promise<void>;
  /** Log in via the dev form (`dev_mode: true` only). */
  signInWithDev: (input: { email: string; displayName: string }) => Promise<void>;
  /** Exchange an OIDC id_token for an app token. */
  signInWithIdToken: (input: {
    externalId: string;
    email: string | null;
    displayName: string;
    idToken: string;
  }) => Promise<void>;
  /** Clear credentials, revoke server session, and wipe query cache. */
  signOut: () => Promise<void>;
  /** Re-read `/auth/config` (used by the login screen retry button). */
  reloadAuthConfig: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<StoredProfile | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Guards the logout path against re-entry when several requests fail at once.
  const signingOutRef = useRef(false);

  /**
   * Shared teardown for both explicit logout and an involuntary auth failure.
   * Clears: server session (if reachable), in-memory token, secure store, and query cache.
   */
  const performLogout = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    const tokenToRevoke = getAccessToken();
    try {
      // Immediately advance session epoch and abort all in-flight requests for the old user
      setAccessToken(null);
      await queryClient.cancelQueries();
      queryClient.clear();
      setUser(null);
      setSession(null);
      await clearAllCredentials();
      if (tokenToRevoke) {
        try {
          await logoutServer(tokenToRevoke);
        } catch {
          // Offline or server unreachable: local session is already cleanly torn down
        }
      }
    } finally {
      setStatus('unauthenticated');
      signingOutRef.current = false;
    }
  }, [queryClient]);

  useEffect(() => {
    setAuthFailureHandler(() => {
      void performLogout();
    });
    return () => setAuthFailureHandler(null);
  }, [performLogout]);

  const loadAuthConfig = useCallback(async () => {
    try {
      const config = await getAuthConfig();
      setAuthConfig(config);
      setConfigError(null);
    } catch (error) {
      setAuthConfig(null);
      setConfigError(
        error instanceof NetworkError
          ? error.message
          : '无法连接后端服务器。请检查后端是否正在运行。',
      );
    }
  }, []);

  // Boot: validate the stored credential, then load the auth configuration.
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setStatus('loading');

      const [token, storedProfile] = await Promise.all([getStoredToken(), getStoredProfile()]);

      if (token) {
        setAccessToken(token);
        try {
          const sessionUser = await getSession();
          if (cancelled) return;
          setSession(sessionUser);
          const profile: StoredProfile = {
            id: sessionUser.id,
            email: sessionUser.email,
            displayName: sessionUser.display_name,
          };
          setUser(profile);
          await setStoredProfile(profile);
          setStatus('authenticated');
        } catch (error) {
          if (cancelled) return;
          setAccessToken(null);
          setSession(null);
          setUser(null);
          if (error instanceof AuthError) {
            await clearAllCredentials();
          }
          setStatus('unauthenticated');
        }
      } else {
        if (!cancelled) {
          setUser(storedProfile);
          setStatus('unauthenticated');
        }
      }

      if (!cancelled) await loadAuthConfig();
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadAuthConfig]);

  const retrySessionOrConfig = useCallback(async () => {
    await loadAuthConfig();
    if (status === 'authenticated') return;
    const token = await getStoredToken();
    if (!token) return;
    setStatus('loading');
    setAccessToken(token);
    try {
      const sessionUser = await getSession();
      setSession(sessionUser);
      const profile: StoredProfile = {
        id: sessionUser.id,
        email: sessionUser.email,
        displayName: sessionUser.display_name,
      };
      setUser(profile);
      await setStoredProfile(profile);
      setStatus('authenticated');
    } catch (error) {
      setAccessToken(null);
      setSession(null);
      setUser(null);
      if (error instanceof AuthError) {
        await clearAllCredentials();
      }
      setStatus('unauthenticated');
    }
  }, [loadAuthConfig, status]);

  /** Shared tail of login flows: cancel stale queries, clear cache, persist, mark authenticated. */
  const finishLogin = useCallback(
    async (input: {
      token: string;
      id: string;
      email: string;
      displayName: string;
      sessionUser?: SessionUser | null;
    }) => {
      await queryClient.cancelQueries();
      queryClient.clear();
      setAccessToken(input.token);
      await setStoredToken(input.token);

      const profile: StoredProfile = {
        id: input.id,
        email: input.email,
        displayName: input.displayName,
      };
      setUser(profile);
      await setStoredProfile(profile);
      setSession(input.sessionUser ?? null);
      setStatus('authenticated');
    },
    [queryClient],
  );

  const signInWithPassword = useCallback(
    async (input: { email: string; password: string }) => {
      setIsSigningIn(true);
      try {
        const result = await loginUser({
          email: input.email.trim(),
          password: input.password,
        });
        await finishLogin({
          token: result.access_token,
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.display_name,
          sessionUser: result.user,
        });
      } finally {
        setIsSigningIn(false);
      }
    },
    [finishLogin],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      code: string;
      displayName?: string | null;
    }) => {
      setIsSigningIn(true);
      try {
        const result = await registerUser({
          email: input.email.trim(),
          password: input.password,
          code: input.code.trim(),
          display_name: input.displayName?.trim() || null,
        });
        await finishLogin({
          token: result.access_token,
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.display_name,
          sessionUser: result.user,
        });
      } finally {
        setIsSigningIn(false);
      }
    },
    [finishLogin],
  );

  const sendCode = useCallback(
    async (email: string, purpose: 'register' | 'reset_password') => {
      return await sendVerificationCode({
        email: email.trim(),
        purpose,
      });
    },
    [],
  );

  const resetPassword = useCallback(
    async (input: { email: string; code: string; newPassword: string }) => {
      setIsSigningIn(true);
      try {
        await apiResetPassword({
          email: input.email.trim(),
          code: input.code.trim(),
          new_password: input.newPassword,
        });
      } finally {
        setIsSigningIn(false);
      }
    },
    [],
  );

  const changePassword = useCallback(
    async (input: { oldPassword: string; newPassword: string }) => {
      await apiChangePassword({
        old_password: input.oldPassword,
        new_password: input.newPassword,
      });
      // Changing password revokes active tokens on backend; cleanly log out locally
      await performLogout();
    },
    [performLogout],
  );

  const signInWithDev = useCallback(
    async (input: { email: string; displayName: string }) => {
      setIsSigningIn(true);
      try {
        const externalId = `dev:${input.email.trim().toLowerCase()}`;
        const result = await syncUser({
          external_id: externalId,
          email: input.email.trim(),
          display_name: input.displayName.trim() || input.email.trim(),
        });
        await finishLogin({
          token: result.access_token,
          id: result.id,
          email: result.email,
          displayName: result.display_name,
        });
      } finally {
        setIsSigningIn(false);
      }
    },
    [finishLogin],
  );

  const signInWithIdToken = useCallback(
    async (input: {
      externalId: string;
      email: string | null;
      displayName: string;
      idToken: string;
    }) => {
      setIsSigningIn(true);
      try {
        const result = await syncUser({
          external_id: input.externalId,
          email: input.email,
          display_name: input.displayName,
          id_token: input.idToken,
          provider: 'oidc',
        });
        await finishLogin({
          token: result.access_token,
          id: result.id,
          email: result.email,
          displayName: result.display_name,
        });
      } finally {
        setIsSigningIn(false);
      }
    },
    [finishLogin],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      session,
      authConfig,
      configError,
      isSigningIn,
      signInWithPassword,
      register,
      sendCode,
      resetPassword,
      changePassword,
      signInWithDev,
      signInWithIdToken,
      signOut: performLogout,
      reloadAuthConfig: retrySessionOrConfig,
    }),
    [
      status,
      user,
      session,
      authConfig,
      configError,
      isSigningIn,
      signInWithPassword,
      register,
      sendCode,
      resetPassword,
      changePassword,
      signInWithDev,
      signInWithIdToken,
      performLogout,
      retrySessionOrConfig,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}
