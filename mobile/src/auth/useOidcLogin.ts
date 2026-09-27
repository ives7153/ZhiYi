import { useCallback, useMemo, useState } from 'react';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { redirectScheme } from '../config/env';

/**
 * OIDC Authorization Code flow with PKCE for a public mobile client.
 *
 * Spec §4.2: no `client_secret` is ever used — the app is a public client, and
 * PKCE is what protects the code exchange.
 *
 * The redirect target is `wardrowbe://auth/callback`, matching
 * `MOBILE_APP_SCHEME` in `backend/app/api/auth.py`. The server also exposes
 * `GET /api/v1/auth/mobile-callback`, which forwards every query parameter to
 * that same custom scheme, for IdPs that cannot be configured with a custom
 * scheme redirect URI.
 *
 * PKCE is handled by `AuthRequest` itself: it generates the verifier, derives the
 * S256 challenge, includes it in the authorization URL, and passes the verifier
 * on `promptAsync`. Re-implementing that by hand would mean re-keeping
 * `code_verifier` alive across the browser round trip, which the library already
 * does correctly via `AuthRequest.codeVerifier`.
 *
 * IMPORTANT: this flow requires a development build. Expo Go can only register
 * `exp://` redirect URIs and cannot claim the `wardrowbe://` scheme, so the
 * browser would have nothing to return to.
 */

/** Lets the Android browser tab hand control back to the app. */
WebBrowser.maybeCompleteAuthSession();

interface OidcLoginResult {
  idToken: string;
  externalId: string;
  email: string | null;
  displayName: string;
}

export function useOidcLogin() {
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  /** `wardrowbe://auth/callback` */
  const redirectUri = useMemo(
    () => AuthSession.makeRedirectUri({ scheme: redirectScheme, path: 'auth/callback' }),
    [],
  );

  /**
   * Runs the flow and returns what `/auth/sync` needs.
   *
   * Throws on cancellation or failure so the caller can render the message.
   */
  const promptAsync = useCallback(
    async (config: { issuerUrl: string; clientId: string }): Promise<OidcLoginResult> => {
      setIsAuthenticating(true);
      try {
        const discovery = await AuthSession.fetchDiscoveryAsync(config.issuerUrl);

      const request = new AuthSession.AuthRequest({
        clientId: config.clientId,
        redirectUri,
        responseType: AuthSession.ResponseType.Code,
        scopes: ['openid', 'profile', 'email'],
        usePKCE: true,
        codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
      });

      const result = await request.promptAsync(discovery);
      if (result.type !== 'success') {
        throw new Error(result.type === 'cancel' || result.type === 'dismiss' ? '登录已取消' : '认证失败');
      }

      // `AuthRequest` reads `error` / `error_description` out of the redirect and
      // surfaces them as an AuthError, which promptAsync rejects with — so a
      // successful result here means we actually have a code.
      const code = result.params?.code;
      if (!code) throw new Error('认证回调缺少授权码');

      const tokenResponse = await AuthSession.exchangeCodeAsync(
        {
          clientId: config.clientId,
          code,
          redirectUri,
          // The verifier the library generated for this request. Required by the
          // token endpoint; no client_secret is sent (public client).
          extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
        },
        discovery,
      );

      const idToken = tokenResponse.idToken;
      if (!idToken) throw new Error('认证响应缺少 id_token');

      const claims = decodeIdTokenClaims(idToken);
      const subject = typeof claims.sub === 'string' ? claims.sub : null;
      if (!subject) throw new Error('id_token 缺少 sub 声明');

      const email = typeof claims.email === 'string' ? claims.email : null;
      const name =
        (typeof claims.name === 'string' && claims.name) ||
        (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
        email ||
        subject;

        return { idToken, externalId: subject, email, displayName: name };
      } finally {
        setIsAuthenticating(false);
      }
    },
    [redirectUri],
  );

  return { promptAsync, redirectUri, isAuthenticating };
}

/**
 * Reads the claims out of an ID token payload.
 *
 * The signature is deliberately NOT verified here. The token is handed straight
 * to `POST /auth/sync`, which verifies it against the issuer's JWKS
 * (`backend/app/utils/oidc.py`) and checks `sub` against `external_id`. Decoding
 * locally only exists to fill in the request fields.
 */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length < 2) throw new Error('id_token 格式不正确');

  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);

  // `atob` is available in Hermes and on web; Buffer covers older Hermes builds.
  const binary =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(padded)
      : (globalThis as { Buffer?: { from: (d: string, e: string) => { toString: (e: string) => string } } }).Buffer?.from(
          padded,
          'base64',
        ).toString('binary');

  if (binary === undefined) throw new Error('当前环境不支持 id_token 解析');

  // The payload can contain multi-byte UTF-8 (names), so decode it properly.
  const json =
    typeof TextDecoder !== 'undefined'
      ? new TextDecoder('utf-8').decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
      : binary;

  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('id_token 载荷解析失败');
  }
}
