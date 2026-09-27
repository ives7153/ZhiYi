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

import { getAuthConfig, getSession, syncUser } from '../api/auth';
import { setAccessToken, setAuthFailureHandler } from '../api/client';
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

/**
 * Authentication state machine.
 *
 * Boot sequence (spec §4.2):
 *   1. read the credential from the secure store
 *   2. if present, validate it with `GET /auth/session`
 *       200        → restore the session
 *       401/403/422 → credential unusable, clear it and show the login screen
 *   3. always load `/auth/config` so the login screen knows which method to offer
 *
 * There is no refresh endpoint, so a failed validation is never retried
 * silently — it goes straight to the login screen.
 */

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
  /** True while a login attempt is in flight. */
  isSigningIn: boolean;
  /** Log in via the dev form (`dev_mode: true` only). */
  signInWithDev: (input: { email: string; displayName: string }) => Promise<void>;
  /** Exchange an OIDC id_token for an app token. */
  signInWithIdToken: (input: {
    externalId: string;
    email: string | null;
    displayName: string;
    idToken: string;
  }) => Promise<void>;
  /** Clear credentials and the whole query cache. */
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
   *
   * Clears, in order: the in-memory token, the persisted credentials, and the
   * React Query cache. The cache clear is the part that prevents the next user
   * from seeing the previous user's wardrobe — every query key is namespaced by
   * `userId`, but clearing wholesale is deliberately belt-and-braces.
   */
  const performLogout = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    try {
      setAccessToken(null);
      setUser(null);
      setSession(null);
      queryClient.clear();
      await clearAllCredentials();
    } finally {
      setStatus('unauthenticated');
      signingOutRef.current = false;
    }
  }, [queryClient]);

  // Any 401/403/422 from any screen lands here exactly once.
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
      // The backend being unreachable is a configuration problem the user must
      // see, not a crash: render the login screen with the error block.
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
          // 401/403/422 → the credential is unusable. Anything else (timeout,
          // unreachable backend) also lands on the login screen, because we
          // cannot prove the session is valid — but only the auth-status case
          // is treated as a definitive rejection.
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

  /** Shared tail of both login flows: persist, seed caches, mark authenticated. */
  const finishLogin = useCallback(
    async (input: {
      token: string;
      id: string;
      email: string;
      displayName: string;
      sessionUser?: SessionUser | null;
    }) => {
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
    [],
  );

  const signInWithDev = useCallback(
    async (input: { email: string; displayName: string }) => {
      setIsSigningIn(true);
      try {
        // `external_id` is free-form in dev mode; deriving it from the email
        // keeps repeat logins tied to the same account.
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
      signInWithDev,
      signInWithIdToken,
      signOut: performLogout,
      reloadAuthConfig: loadAuthConfig,
    }),
    [
      status,
      user,
      session,
      authConfig,
      configError,
      isSigningIn,
      signInWithDev,
      signInWithIdToken,
      performLogout,
      loadAuthConfig,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}
