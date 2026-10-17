import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme/ThemeContext";
import { zh } from "../i18n/zh";

interface SaveOutfitModalProps {
  visible: boolean;
  defaultName: string;
  itemCount: number;
  isTrial: boolean;
  saving: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (name: string) => void;
}

export function SaveOutfitModal({
  visible,
  defaultName,
  itemCount,
  isTrial,
  saving,
  error,
  onClose,
  onSave,
}: SaveOutfitModalProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(defaultName);

  React.useEffect(() => {
    if (visible) {
      setName(defaultName);
    }
  }, [visible, defaultName]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              borderRadius: 20,
              padding: spacing.lg,
            },
          ]}
        >
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isTrial ? "保存试搭" : "保存这套搭配"}
          </Text>

          <Text style={[styles.subText, { color: colors.mutedForeground }]}>
            包含 {itemCount} 件单品{isTrial ? "（含待购单品）" : ""}
          </Text>

          {/* Name Input */}
          <View style={styles.inputSection}>
            <Text style={[styles.inputLabel, { color: colors.foreground }]}>搭配名称（可选）</Text>
            <View
              style={[
                styles.inputWrapper,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderRadius: radius,
                },
              ]}
            >
              <TextInput
                style={[styles.input, { color: colors.foreground }]}
                value={name}
                onChangeText={setName}
                placeholder="给这套搭配起个名字..."
                placeholderTextColor={colors.mutedForeground}
                maxLength={50}
              />
            </View>
          </View>

          {error ? (
            <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          ) : null}

          {/* Action Buttons */}
          <View style={styles.buttonRow}>
            <Pressable
              onPress={onClose}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="取消"
              style={[
                styles.btn,
                styles.cancelBtn,
                { borderColor: colors.border, borderRadius: radius },
              ]}
            >
              <Text style={[styles.cancelBtnText, { color: colors.mutedForeground }]}>取消</Text>
            </Pressable>

            <Pressable
              onPress={() => onSave(name)}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="确认保存"
              style={[
                styles.btn,
                styles.confirmBtn,
                { backgroundColor: colors.primary, borderRadius: radius },
              ]}
            >
              {saving ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <Text style={[styles.confirmBtnText, { color: colors.primaryForeground }]}>确认保存</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  subText: {
    fontSize: 13,
    marginBottom: 16,
  },
  inputSection: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },
  inputWrapper: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    fontSize: 14,
    padding: 0,
  },
  errorText: {
    fontSize: 12,
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtn: {
    borderWidth: 1,
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: "500",
  },
  confirmBtn: {},
  confirmBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
