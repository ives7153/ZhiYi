import { request } from './client';
import type {
  AuthConfigResponse,
  AuthStatusResponse,
  SessionUser,
  UserSyncRequest,
  UserSyncResponse,
} from './types';

/**
 * Auth endpoints — the exact contract implemented by `backend/app/api/auth.py`.
 *
 * There is NO refresh endpoint. `create_access_token` issues a 7-day HS256 JWT
 * and the only way to obtain one is `POST /auth/sync`. A 401 therefore forces
 * re-authentication; the client must never attempt a silent refresh.
 */

/** `GET /auth/config` — decides which login UI to render. Public. */
export function getAuthConfig(): Promise<AuthConfigResponse> {
  return request<AuthConfigResponse>('/auth/config', {
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `GET /auth/status` — whether the backend has any auth method configured. */
export function getAuthStatus(): Promise<AuthStatusResponse> {
  return request<AuthStatusResponse>('/auth/status', {
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/**
 * `POST /auth/sync` — the ONLY token exchange.
 *
 * In dev mode the body is `{ external_id, email, display_name }` and `id_token`
 * is not required. When OIDC is configured, `id_token` is mandatory and the
 * server verifies `claims.sub === external_id`.
 *
 * `triggerAuthFailure: false` because a rejected login is a form error to show
 * on the login screen, not a signal to log out the current session.
 */
export function syncUser(payload: UserSyncRequest): Promise<UserSyncResponse> {
  return request<UserSyncResponse>('/auth/sync', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/**
 * `GET /auth/session` — validates the stored credential on cold start.
 *
 * Returns 200 with the user, or 401/403/422 when the credential is unusable.
 * Note that 422 is a real possibility here (the response model validates `email`
 * as `EmailStr`), which is why `AuthError` covers all three statuses.
 */
export function getSession(): Promise<SessionUser> {
  return request<SessionUser>('/auth/session', {
    triggerAuthFailure: false,
    // The only endpoint whose response is gated on the credential itself, so the
    // only one where a 422 means "this account's email cannot satisfy the
    // response model" rather than "this payload is invalid".
    credentialChecked: true,
  });
}
