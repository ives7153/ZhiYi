import React, { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUserProfile } from '../../src/api/hooks';
import { useAuth } from '../../src/auth/AuthContext';
import { Button } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeContext';
import { apiBaseUrl, isApiConfigured } from '../../src/config/env';
import { zh } from '../../src/i18n/zh';

/**
 * 我的 (profile) — spec §6.6.
 *
 * Read-only account card from `/users/me`, plus the diagnostics that matter when
 * a developer is pointing the app at the wrong host: the resolved backend URL.
 * The signed-out action is confirmed first, because it destroys the credential
 * and the cache.
 */
export default function ProfileScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { signOut, user: cachedUser } = useAuth();
  const { data: profile, isLoading, isError } = useUserProfile();
  const [signingOut, setSigningOut] = useState(false);

  const displayName = profile?.display_name ?? cachedUser?.displayName ?? '—';
  const email = profile?.email ?? cachedUser?.email ?? '—';

  function confirmSignOut() {
    Alert.alert(zh.profile.signOutConfirmTitle, zh.profile.signOutConfirmMessage, [
      { text: zh.profile.cancel, style: 'cancel' },
      {
        text: zh.profile.confirm,
        style: 'destructive',
        onPress: () => {
          setSigningOut(true);
          // Clears the token, the stored profile and the whole query cache.
          void signOut().finally(() => setSigningOut(false));
        },
      },
    ]);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.xxl * 2,
        gap: spacing.xl,
      }}
    >
      <Text style={{ ...typography.screenTitle, color: colors.foreground }}>{zh.profile.title}</Text>

      <Section title={zh.profile.accountSection} description={zh.profile.accountDescription}>
        <Row label={zh.profile.name} value={isLoading ? zh.common.loading : displayName} first />
        <Row label={zh.profile.email} value={isLoading ? zh.common.loading : email} />
        {isError ? (
          <Row label={zh.common.error} value={zh.wardrobe.errors.loadFailed} />
        ) : null}
      </Section>

      <Section title={zh.profile.appSection}>
        <Row
          label={zh.profile.apiBaseUrl}
          value={isApiConfigured ? (apiBaseUrl as string) : '未配置 EXPO_PUBLIC_API_URL'}
          first
        />
        <Row label={zh.profile.version} value={Constants.expoConfig?.version ?? '1.0.0'} />
      </Section>

      <Button
        title={zh.profile.signOut}
        variant="destructive"
        loading={signingOut}
        onPress={confirmSignOut}
      />
    </ScrollView>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const { colors, spacing, typography, radius } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <View>
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.foreground }}>{title}</Text>
        {description ? (
          <Text style={{ ...typography.subtitle, color: colors.mutedForeground, marginTop: 2 }}>
            {description}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius,
          backgroundColor: colors.card,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Row({ label, value, first = false }: { label: string; value: string; first?: boolean }) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.border,
      }}
    >
      <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>{label}</Text>
      <Text
        numberOfLines={2}
        style={{ color: colors.foreground, fontSize: 14, flex: 1, textAlign: 'right' }}
      >
        {value}
      </Text>
    </View>
  );
}

