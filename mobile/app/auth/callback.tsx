import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useAuth } from '../../src/auth/AuthContext';
import { ErrorState } from '../../src/components/states';
import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * OIDC redirect landing page — `wardrowbe://auth/callback`.
 *
 * `useOidcLogin` normally completes the exchange inside
 * `WebBrowser.openAuthSessionAsync` and never reaches this screen. This route
 * exists for the two cases that do:
 *
 *  1. the app was cold-started by the deep link (the original JS context is gone,
 *     so nothing is waiting for the browser result);
 *  2. the IdP was configured with the server-side redirect
 *     `GET /api/v1/auth/mobile-callback`, which 302s here with the parameters.
 *
 * The `code` alone is not enough to finish: exchanging it requires the PKCE
 * `code_verifier`, which is held only in the in-flight hook. So when we land here
 * we surface a clear error instead of silently failing — the user can retry, and
 * on a cold start that is the only correct answer.
 */
export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>();
  const router = useRouter();
  const { colors, spacing, typography } = useTheme();
  const { status } = useAuth();
  const handledRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    if (status === 'authenticated') {
      // Already signed in (the in-flight hook completed the exchange); just move on.
      router.replace('/(tabs)');
      return;
    }

    if (params.error) {
      setMessage(params.error_description || `认证失败：${params.error}`);
      return;
    }

    setMessage('无法在此完成登录：请从登录页重新发起 SSO 登录。');
  }, [params.error, params.error_description, router, status]);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, padding: spacing.lg, gap: spacing.lg },
      ]}
    >
      {message ? (
        <ErrorState message={message} onRetry={() => router.replace('/login')} />
      ) : (
        <>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ ...typography.subtitle, color: colors.mutedForeground }}>
            {zh.common.loading}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
