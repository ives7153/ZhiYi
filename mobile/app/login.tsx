import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Eye, EyeOff, Loader2 } from 'lucide-react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useOidcLogin } from '../src/auth/useOidcLogin';
import { ApiError, NetworkError } from '../src/api/errors';
import { Button, Input } from '../src/components/ui';
import { Logo } from '../src/components/Logo';
import { useTheme } from '../src/theme/ThemeContext';
import { zh } from '../src/i18n/zh';

type AuthMode = 'login' | 'register' | 'forgot_password';

export default function LoginScreen() {
  const { colors, radius, spacing, typography, iconSizes } = useTheme();
  const {
    authConfig,
    configError,
    isSigningIn,
    signInWithPassword,
    register,
    sendCode,
    resetPassword,
    signInWithIdToken,
    reloadAuthConfig,
  } = useAuth();
  const oidc = useOidcLogin();

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // 60-second countdown for verification code
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const timerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function startCountdown() {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function validateEmail(val: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val.trim());
  }

  async function handleSendCode() {
    setFormError(null);
    setFormSuccess(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFormError('请输入邮箱');
      return;
    }
    if (!validateEmail(trimmedEmail)) {
      setFormError('请输入有效的邮箱地址');
      return;
    }

    setSendingCode(true);
    try {
      const purpose = mode === 'register' ? 'register' : 'reset_password';
      const res = await sendCode(trimmedEmail, purpose);
      setFormSuccess(res.message || zh.login.codeSentNotice);
      startCountdown();
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.detail ?? '验证码发送失败，请稍后重试。');
      } else if (error instanceof Error) {
        setFormError(error.message);
      } else {
        setFormError('验证码发送失败，请稍后重试。');
      }
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit() {
    setFormError(null);
    setFormSuccess(null);
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      setFormError('请输入邮箱');
      return;
    }
    if (!validateEmail(trimmedEmail)) {
      setFormError('请输入有效的邮箱地址');
      return;
    }

    if (mode === 'login') {
      if (!password) {
        setFormError('请输入密码');
        return;
      }
      try {
        await signInWithPassword({ email: trimmedEmail, password });
      } catch (error) {
        if (error instanceof ApiError) {
          setFormError(error.detail ?? '登录失败，请核对邮箱与密码。');
        } else if (error instanceof Error) {
          setFormError(error.message);
        } else {
          setFormError('登录失败，请重试。');
        }
      }
      return;
    }

    if (mode === 'register') {
      if (!code.trim()) {
        setFormError('请输入邮箱验证码');
        return;
      }
      if (password.length < 8) {
        setFormError('密码至少需要 8 个字符');
        return;
      }
      if (password !== confirmPassword) {
        setFormError('两次输入的密码不一致');
        return;
      }

      try {
        await register({
          email: trimmedEmail,
          password,
          code: code.trim(),
          displayName: displayName.trim() || undefined,
        });
      } catch (error) {
        if (error instanceof NetworkError && error.outcomeUnknown) {
          setFormError(
            '网络连接中断或超时，未能确认注册结果。若账号已创建，可直接切换至“登录”使用该邮箱和密码登录，或通过“忘记密码”恢复。',
          );
        } else if (error instanceof ApiError) {
          setFormError(error.detail ?? '注册请求未能完成，请检查验证码或重试。');
        } else if (error instanceof Error) {
          setFormError(error.message);
        } else {
          setFormError('注册请求未能完成，请重试。');
        }
      }
      return;
    }

    if (mode === 'forgot_password') {
      if (!code.trim()) {
        setFormError('请输入邮箱验证码');
        return;
      }
      if (password.length < 8) {
        setFormError('新密码至少需要 8 个字符');
        return;
      }
      if (password !== confirmPassword) {
        setFormError('两次输入的密码不一致');
        return;
      }

      try {
        await resetPassword({
          email: trimmedEmail,
          code: code.trim(),
          newPassword: password,
        });
        setFormSuccess(zh.login.resetSuccess);
        setMode('login');
        setPassword('');
        setConfirmPassword('');
        setCode('');
      } catch (error) {
        if (error instanceof NetworkError && error.outcomeUnknown) {
          setFormError(
            '网络连接中断或超时，未能确认重置结果。您可尝试返回登录使用新密码登录，或重新获取验证码后再试。',
          );
        } else if (error instanceof ApiError) {
          setFormError(error.detail ?? '重置密码失败，请核对验证码。');
        } else if (error instanceof Error) {
          setFormError(error.message);
        } else {
          setFormError('重置密码失败，请重试。');
        }
      }
    }
  }

  async function handleOidcLogin() {
    setFormError(null);
    setFormSuccess(null);
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
  const passwordAuthEnabled = authConfig ? authConfig.password_auth !== false : true;
  const registrationEnabled = authConfig
    ? authConfig.registration_enabled !== false && passwordAuthEnabled
    : true;
  function switchMode(target: AuthMode) {
    setMode(target);
    setFormError(null);
    setFormSuccess(null);
    setPassword('');
    setConfirmPassword('');
    setCode('');
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { padding: spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ width: '100%', maxWidth: 400, gap: spacing.xl }}>
          <View style={{ alignItems: 'center', gap: spacing.xs }}>
            <Logo size={iconSizes.logo} />
            <Text style={{ ...typography.screenTitle, color: colors.foreground, marginTop: spacing.xs }}>
              {mode === 'login'
                ? zh.login.title
                : mode === 'register'
                  ? zh.login.registerTitle
                  : zh.login.resetTitle}
            </Text>
            <Text style={{ ...typography.subtitle, color: colors.mutedForeground, textAlign: 'center' }}>
              {mode === 'login'
                ? zh.login.subtitle
                : mode === 'register'
                  ? zh.login.registerSubtitle
                  : zh.login.resetSubtitle}
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
              <Text style={{ color: colors.destructive, fontWeight: '600' }}>
                {zh.login.backendErrorTitle}
              </Text>
              <Text style={{ color: colors.destructive, fontSize: 13 }}>{configError}</Text>
              <Button
                title={zh.common.retry}
                variant="outline"
                size="sm"
                onPress={reloadAuthConfig}
              />
            </View>
          ) : null}

          {formError ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.destructive,
                backgroundColor: colors.destructive + '15',
                borderRadius: radius,
                padding: spacing.md,
              }}
            >
              <Text style={{ color: colors.destructive, fontSize: 14 }}>{formError}</Text>
            </View>
          ) : null}

          {formSuccess ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: '#10B981',
                backgroundColor: '#10B98118',
                borderRadius: radius,
                padding: spacing.md,
              }}
            >
              <Text style={{ color: '#059669', fontSize: 14 }}>{formSuccess}</Text>
            </View>
          ) : null}

          {/* Core Auth Form (shown when local password auth is enabled) */}
          {passwordAuthEnabled ? (
          <View style={{ gap: spacing.md }}>
            <View style={{ gap: spacing.xs }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground }}>
                {zh.login.email}
              </Text>
              <Input
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                editable={!busy}
              />
            </View>

            {mode === 'register' ? (
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground }}>
                  {zh.login.displayName}（选填）
                </Text>
                <Input
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={zh.login.namePlaceholder}
                  editable={!busy}
                />
              </View>
            ) : null}

            {mode !== 'login' ? (
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground }}>
                  {zh.login.verificationCode}
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Input
                      value={code}
                      onChangeText={setCode}
                      placeholder={zh.login.codePlaceholder}
                      keyboardType="numeric"
                      maxLength={6}
                      editable={!busy}
                    />
                  </View>
                  <Button
                    title={
                      countdown > 0
                        ? zh.login.resendAfter(countdown)
                        : zh.login.getCode
                    }
                    variant="outline"
                    size="default"
                    disabled={busy || countdown > 0 || sendingCode}
                    loading={sendingCode}
                    onPress={handleSendCode}
                  />
                </View>
              </View>
            ) : null}

            <View style={{ gap: spacing.xs }}>
              <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground }}>
                {mode === 'forgot_password' ? zh.profile.newPassword : zh.login.password}
              </Text>
              <Input
                value={password}
                onChangeText={setPassword}
                placeholder={zh.login.passwordPlaceholder}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoComplete={mode === 'login' ? 'password' : 'new-password'}
                textContentType={mode === 'login' ? 'password' : 'newPassword'}
                editable={!busy}
                trailingIcon={
                  <Pressable
                    hitSlop={8}
                    onPress={() => setShowPassword((prev) => !prev)}
                    style={{ padding: spacing.xs }}
                  >
                    {showPassword ? (
                      <EyeOff size={18} color={colors.mutedForeground} />
                    ) : (
                      <Eye size={18} color={colors.mutedForeground} />
                    )}
                  </Pressable>
                }
              />
            </View>

            {mode !== 'login' ? (
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground }}>
                  {zh.login.confirmPassword}
                </Text>
                <Input
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder={zh.login.confirmPasswordPlaceholder}
                  secureTextEntry={!showConfirmPassword}
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                  editable={!busy}
                  trailingIcon={
                    <Pressable
                      hitSlop={8}
                      onPress={() => setShowConfirmPassword((prev) => !prev)}
                      style={{ padding: spacing.xs }}
                    >
                      {showConfirmPassword ? (
                        <EyeOff size={18} color={colors.mutedForeground} />
                      ) : (
                        <Eye size={18} color={colors.mutedForeground} />
                      )}
                    </Pressable>
                  }
                />
              </View>
            ) : null}

            {mode === 'login' ? (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: -spacing.xs }}>
                <Pressable hitSlop={8} onPress={() => switchMode('forgot_password')}>
                  <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '500' }}>
                    {zh.login.forgotPassword}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <Button
              title={
                busy
                  ? zh.login.signingIn
                  : mode === 'login'
                    ? zh.login.title
                    : mode === 'register'
                      ? zh.login.submitRegister
                      : zh.login.submitReset
              }
              variant="default"
              size="lg"
              loading={busy}
              disabled={busy}
              onPress={handleSubmit}
              style={{ marginTop: spacing.sm }}
            />

            {/* Mode switch links */}
            <View style={{ alignItems: 'center', marginTop: spacing.sm }}>
              {mode === 'login' ? (
                registrationEnabled ? (
                  <Pressable hitSlop={10} onPress={() => switchMode('register')}>
                    <Text style={{ fontSize: 14, color: colors.primary, fontWeight: '500' }}>
                      {zh.login.toRegister}
                    </Text>
                  </Pressable>
                ) : null
              ) : (
                <Pressable hitSlop={10} onPress={() => switchMode('login')}>
                  <Text style={{ fontSize: 14, color: colors.primary, fontWeight: '500' }}>
                    {zh.login.toLogin}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
          ) : null}

          {/* OIDC Login if configured */}
          {authConfig?.oidc.enabled ? (
            <View style={{ marginTop: spacing.xs, gap: spacing.md }}>
              {passwordAuthEnabled ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                  <Text style={{ fontSize: 12, color: colors.mutedForeground }}>或者</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                </View>
              ) : null}
              <Button
                title={zh.login.oidcButton}
                variant={passwordAuthEnabled ? 'outline' : 'default'}
                size="lg"
                loading={oidc.isAuthenticating}
                disabled={busy}
                onPress={handleOidcLogin}
              />
            </View>
          ) : null}
          {/* End of auth methods */}

          <Text
            style={{
              fontSize: 12,
              color: colors.mutedForeground,
              textAlign: 'center',
              lineHeight: 18,
            }}
          >
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
