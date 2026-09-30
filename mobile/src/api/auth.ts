import { request } from './client';
import type {
  AuthConfigResponse,
  AuthStatusResponse,
  ChangePasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  SendCodeRequest,
  SendCodeResponse,
  SessionUser,
  TokenResponse,
  UserSyncRequest,
  UserSyncResponse,
} from './types';

/**
 * Auth endpoints — the contract implemented by `backend/app/api/auth.py`.
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

/** `POST /auth/send-code` — send verification code. */
export function sendVerificationCode(payload: SendCodeRequest): Promise<SendCodeResponse> {
  return request<SendCodeResponse>('/auth/send-code', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/register` — formal email + password registration. */
export function registerUser(payload: RegisterRequest): Promise<TokenResponse> {
  return request<TokenResponse>('/auth/register', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/login` — formal email + password login. */
export function loginUser(payload: LoginRequest): Promise<TokenResponse> {
  return request<TokenResponse>('/auth/login', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/forgot-password` — password reset code request. */
export function forgotPassword(payload: SendCodeRequest): Promise<SendCodeResponse> {
  return request<SendCodeResponse>('/auth/forgot-password', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/reset-password` — reset password using code. */
export function resetPassword(payload: ResetPasswordRequest): Promise<{ detail: string }> {
  return request<{ detail: string }>('/auth/reset-password', {
    method: 'POST',
    body: payload,
    skipAuth: true,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/change-password` — authenticated user change password. */
export function changePassword(payload: ChangePasswordRequest): Promise<{ detail: string }> {
  return request<{ detail: string }>('/auth/change-password', {
    method: 'POST',
    body: payload,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/logout` — revoke online server session. */
export function logoutServer(tokenOverride?: string | null): Promise<{ detail: string }> {
  return request<{ detail: string }>('/auth/logout', {
    method: 'POST',
    tokenOverride,
    triggerAuthFailure: false,
  });
}

/** `POST /auth/sync` — OIDC or dev token exchange. */
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
 */
export function getSession(): Promise<SessionUser> {
  return request<SessionUser>('/auth/session', {
    triggerAuthFailure: false,
    credentialChecked: true,
  });
}
