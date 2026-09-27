import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../theme/ThemeContext';

/**
 * Shared primitives approximating the Web app's shadcn/ui components with the
 * exact tokens from the spec. Kept intentionally small — only the variants the
 * round-1 screens actually use.
 */

export function Button({
  title,
  onPress,
  variant = 'default',
  size = 'default',
  disabled = false,
  loading = false,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius, spacing, iconSizes } = useTheme();
  const isDisabled = disabled || loading;

  const background =
    variant === 'default'
      ? colors.primary
      : variant === 'destructive'
        ? 'transparent'
        : 'transparent';
  const borderColor =
    variant === 'outline' || variant === 'destructive' ? colors.border : 'transparent';
  const textColor =
    variant === 'default'
      ? colors.primaryForeground
      : variant === 'destructive'
        ? colors.destructive
        : colors.foreground;

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'destructive' ? colors.destructive : borderColor,
          borderWidth: variant === 'outline' || variant === 'destructive' ? 1 : 0,
          borderRadius: radius,
          paddingVertical: size === 'lg' ? spacing.md : spacing.sm + 2,
          paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        icon ?? null
      )}
      <Text
        style={{
          color: textColor,
          fontSize: size === 'sm' ? 13 : 14,
          fontWeight: '500',
          marginLeft: loading || icon ? spacing.sm : 0,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius, cardShadow } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius,
        },
        cardShadow,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Input({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = 'none',
  autoCorrect = false,
  editable = true,
  onSubmitEditing,
  leadingIcon,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  autoCorrect?: boolean;
  editable?: boolean;
  onSubmitEditing?: () => void;
  /** Rendered inside the field's leading edge, e.g. the search icon. */
  leadingIcon?: React.ReactNode;
}) {
  const { colors, radius, spacing } = useTheme();
  const [focused, setFocused] = React.useState(false);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: focused ? colors.ring : colors.input,
        borderRadius: radius,
        backgroundColor: colors.background,
        paddingHorizontal: spacing.md,
      }}
    >
      {leadingIcon}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        editable={editable}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmitEditing}
        // 16px keeps iOS from zooming on focus; same intent as the Web CSS rule.
        style={{
          flex: 1,
          color: colors.foreground,
          fontSize: 16,
          paddingVertical: spacing.md,
        }}
      />
    </View>
  );
}


export function Badge({
  label,
  tone = 'default',
  icon,
}: {
  label: string;
  tone?: 'default' | 'secondary' | 'destructive';
  icon?: React.ReactNode;
}) {
  const { colors, radius, spacing } = useTheme();
  const backgroundColor =
    tone === 'secondary' ? colors.secondary : tone === 'destructive' ? colors.destructive : colors.primary;
  const textColor =
    tone === 'secondary' ? colors.secondaryForeground : colors.primaryForeground;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        backgroundColor,
        borderRadius: radius,
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
        alignSelf: 'flex-start',
      }}
    >
      {icon}
      <Text style={{ color: textColor, fontSize: 12, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

export function Skeleton({
  width,
  height,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, radius } = useTheme();
  return (
    <View
      style={[
        { width, height, backgroundColor: colors.muted, borderRadius: radius },
        style,
      ]}
    />
  );
}

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const { colors, typography, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: spacing.md,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...typography.screenTitle, color: colors.foreground }}>{title}</Text>
        {subtitle ? (
          <Text
            style={{
              ...typography.subtitle,
              color: colors.mutedForeground,
              marginTop: spacing.xs,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export { ActivityIndicator, Text, View, Pressable };
export type { ViewStyle };
