import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LayoutGrid } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * 搭配 (outfits) — honest placeholder for round 1.
 *
 * The spec forbids faking this feature: no mock data, no pretend interaction,
 * just the title and what is planned. Slot-based outfits arrive in round 3.
 */
export default function OutfitsScreen() {
  const { colors, spacing, typography, iconSizes } = useTheme();
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
      <Text style={{ ...typography.screenTitle, color: colors.foreground }}>{zh.outfits.title}</Text>

      <View style={styles.center}>
        <View
          style={{
            padding: spacing.xl,
            borderRadius: 999,
            backgroundColor: colors.muted,
            marginBottom: spacing.lg,
          }}
        >
          <LayoutGrid size={48} color={colors.mutedForeground} />
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
          {zh.outfits.placeholder}
        </Text>
        <Text
          style={{
            ...typography.subtitle,
            color: colors.mutedForeground,
            textAlign: 'center',
            maxWidth: 320,
          }}
        >
          {zh.outfits.description}
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
