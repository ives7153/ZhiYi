import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';

/**
 * A minimal confirmation modal.
 *
 * `Alert.alert` is not used because its button ordering and styling differ per
 * platform and cannot be checked from a UI dump reliably; a real component keeps
 * the destructive action's wording, colour and position identical everywhere, and
 * makes the exact copy reviewable in the source.
 *
 * The `destructive` flag only changes the confirm button's colour — the wording,
 * which is what actually informs the user, is passed in by the caller because only
 * the caller knows what the action really does.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = zh.itemActions.cancel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      {/* Tapping the scrim cancels, matching the platform convention. */}
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityRole="button">
        {/* Stop propagation: a tap inside the card must not dismiss it. */}
        <Pressable
          style={{
            width: '100%',
            maxWidth: 360,
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius,
            padding: spacing.lg,
            gap: spacing.md,
          }}
          onPress={() => {}}
        >
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: '600' }}>
            {title}
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 14, lineHeight: 20 }}>
            {message}
          </Text>

          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm }}>
            <DialogButton label={cancelLabel} onPress={onCancel} muted />
            <DialogButton
              label={confirmLabel}
              onPress={onConfirm}
              destructive={destructive}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DialogButton({
  label,
  onPress,
  muted = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  muted?: boolean;
  destructive?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();

  const background = destructive ? colors.destructive : muted ? 'transparent' : colors.primary;
  const textColor = destructive || !muted ? colors.primaryForeground : colors.foreground;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.md,
        borderRadius: radius,
        borderWidth: muted ? 1 : 0,
        borderColor: colors.border,
        backgroundColor: background,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: textColor, fontSize: 14, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
});
