import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ShoppingBag } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 待购 (to-buy) — honest placeholder for round 1.
 *
 * Same rule as 搭配: no fabricated data, no fake interactivity. To-buy records
 * and their user isolation arrive in round 4.
 */
export default function ToBuyScreen() {
  const { colors, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        paddingTop: insets.top + spacing.lg,
        paddingHorizontal: spacing.lg,
      }}
    >
      <Text style={{ ...typography.screenTitle, color: colors.foreground }}>{zh.toBuy.title}</Text>

      <View style={styles.center}>
        <View
          style={{
            padding: spacing.xl,
            borderRadius: 999,
            backgroundColor: colors.muted,
            marginBottom: spacing.lg,
          }}
        >
          <ShoppingBag size={48} color={colors.mutedForeground} />
        </View>
        <Text
          style={{
            fontSize: 18,
            fontWeight: '600',
            color: colors.foreground,
            marginBottom: spacing.sm,
            textAlign: 'center',
          }}
        >
          {zh.toBuy.placeholder}
        </Text>
        <Text
          style={{
            ...typography.subtitle,
            color: colors.mutedForeground,
            textAlign: 'center',
            maxWidth: 320,
          }}
        >
          {zh.toBuy.description}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 64,
  },
});
