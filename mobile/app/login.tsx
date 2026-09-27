import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Loader2 } from 'lucide-react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useOidcLogin } from '../src/auth/useOidcLogin';
import { ApiError } from '../src/api/errors';
import { Button, Input } from '../src/components/ui';
import { Logo } from '../src/components/Logo';
import { useTheme } from '../src/theme/ThemeContext';
import { zh } from '../src/i18n/zh';

/**
 * Login screen, mirroring `frontend/app/login/page.tsx` plus the spec §6.3 spec.
 *
 * Which method is offered comes from `GET /auth/config`:
 *  - `dev_mode: true`  → the email/name form, with the amber dev-only notice
 *  - `oidc.enabled`    → the SSO button (Authorization Code + PKCE, no secret)
 *  - neither           → a red "no auth method configured" block
 *
 * The dev form is intentionally NOT prefilled with a `.local` address. The
 * backend validates the `/auth/session` response model's `email` as `EmailStr`,
 * and a reserved TLD such as `.local` makes that one endpoint answer 422 while
 * the rest of the API works — a confusing state to land a new user in.
 */
export default function LoginScreen() {
  const { colors, radius, spacing, typography, iconSizes } = useTheme();
  const { authConfig, configError, isSigningIn, signInWithDev, signInWithIdToken, reloadAuthConfig } =
    useAuth();
  const oidc = useOidcLogin();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const devMode = authConfig?.dev_mode === true;
  const oidcEnabled = authConfig?.oidc.enabled === true;

  async function handleDevLogin() {
    setFormError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFormError('请输入邮箱');
      return;
    }
    // Cheap shape check; the server remains the authority on validity.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setFormError('请输入有效的邮箱地址，例如 dev@example.com');
      return;
    }
    try {
      await signInWithDev({ email: trimmedEmail, displayName });
    } catch (error) {
      // `unknown` in TS: narrow by class, not by shape. A rejected form
      // submission is a form error, never a reason to tear down a session.
      if (error instanceof ApiError) {
        setFormError(error.detail ?? '登录失败，请重试。');
      } else if (error instanceof Error) {
        setFormError(error.message);
      } else {
        setFormError('登录失败，请重试。');
      }
    }
  }

  async function handleOidcLogin() {
    setFormError(null);
    const issuerUrl = authConfig?.oidc.issuer_url;
    const clientId = authConfig?.oidc.client_id;
    if (!issuerUrl || !clientId) {
      setFormError('后端 OIDC 配置不完整');
      return;
    }
    try {
      const result = await oidc.promptAsync({ issuerUrl, clientId });
      await signInWithIdToken(result);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '认证失败，请重试。');
    }
  }

  const busy = isSigningIn || oidc.isAuthenticating;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { padding: spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: '100%', maxWidth: 400, gap: spacing.xxl }}>
          <View style={{ alignItems: 'center', gap: spacing.sm }}>
            <Logo size={iconSizes.logo} />
            <Text style={{ ...typography.screenTitle, color: colors.foreground, marginTop: spacing.sm }}>
              {zh.login.title}
            </Text>
            <Text style={{ ...typography.subtitle, color: colors.mutedForeground }}>
              {zh.login.subtitle}
            </Text>
          </View>

          {configError ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.destructive,
                backgroundColor: colors.destructive + '1A',
                borderRadius: radius,
                padding: spacing.lg,
                gap: spacing.sm,
              }}
            >
              <Text style={{ color: colors.destructive, fontWeight: '600', fontSize: 14 }}>
                {zh.login.backendErrorTitle}
              </Text>
              <Text style={{ color: colors.destructive, fontSize: 14 }}>
                {zh.login.backendErrorDescription}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{configError}</Text>
              <Button title={zh.common.retry} variant="outline" onPress={() => void reloadAuthConfig()} />
            </View>
          ) : null}

          {/* Dev-only banner, exactly as the Web renders it. */}
          {devMode ? (
            <View
              style={{
                backgroundColor: colors.muted,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius,
                padding: spacing.md,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 13 }}>{zh.login.devMode}</Text>
            </View>
          ) : null}

          {!authConfig && !configError ? (
            <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
              <Loader2 size={iconSizes.nav} color={colors.mutedForeground} />
            </View>
          ) : null}

          {oidcEnabled ? (
            <Button
              title={oidc.isAuthenticating ? zh.login.signingIn : zh.login.oidcButton}
              size="lg"
              loading={oidc.isAuthenticating}
              disabled={busy}
              onPress={() => void handleOidcLogin()}
            />
          ) : null}

          {devMode ? (
            <View style={{ gap: spacing.lg }}>
              <View style={{ gap: spacing.sm }}>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.foreground }}>
                  {zh.login.email}
                </Text>
                <Input
                  value={email}
                  onChangeText={setEmail}
                  placeholder="dev@example.com"
                  keyboardType="email-address"
                  editable={!busy}
                />
              </View>

              <View style={{ gap: spacing.sm }}>
                <Text style={{ fontSize: 14, fontWeight: '500', color: colors.foreground }}>
                  {zh.login.displayName}
                </Text>
                <Input
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={zh.login.namePlaceholder}
                  autoCapitalize="words"
                  editable={!busy}
                  onSubmitEditing={() => void handleDevLogin()}
                />
              </View>

              {formError ? (
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: colors.destructive,
                    backgroundColor: colors.destructive + '1A',
                    borderRadius: radius,
                    padding: spacing.md,
                  }}
                >
                  <Text style={{ color: colors.destructive, fontSize: 13 }}>{formError}</Text>
                </View>
              ) : null}

              <Button
                title={isSigningIn ? zh.login.signingIn : zh.login.title}
                size="lg"
                loading={isSigningIn}
                disabled={busy}
                onPress={() => void handleDevLogin()}
              />
            </View>
          ) : null}

          {authConfig && !devMode && !oidcEnabled ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.destructive,
                backgroundColor: colors.destructive + '1A',
                borderRadius: radius,
                padding: spacing.lg,
                gap: spacing.sm,
              }}
            >
              <Text style={{ color: colors.destructive, fontWeight: '600', fontSize: 14 }}>
                {zh.login.unconfiguredTitle}
              </Text>
              <Text style={{ color: colors.destructive, fontSize: 13 }}>
                {zh.login.unconfiguredDescription}
              </Text>
            </View>
          ) : null}

          <Text style={{ ...typography.subtitle, color: colors.mutedForeground, textAlign: 'center' }}>
            {zh.login.termsAgreement}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
