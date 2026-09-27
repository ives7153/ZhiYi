import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CLOTHING_TYPES, COLOR_CHOICES, clothingTypeLabel, colorLabel } from '../api/itemVocab';
import { useTheme } from '../theme/ThemeContext';
import { zh } from '../i18n/zh';

/**
 * Form primitives shared by the add and edit screens.
 *
 * They exist so the two screens cannot drift apart on the things that matter for
 * correctness — in particular that a "not chosen" type is submitted as *absent*
 * rather than as the literal string `unknown`, which the server would store
 * verbatim as if a human had picked it.
 */

/** A labelled single-select rendered as wrapping chips. */
export function ChipSelect({
  label,
  options,
  value,
  onChange,
  allowClear = true,
  placeholder,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (next: string | null) => void;
  allowClear?: boolean;
  placeholder?: string;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {allowClear ? (
          <Chip
            label={placeholder ?? zh.wardrobe.allTypes}
            active={value === null}
            onPress={() => onChange(null)}
          />
        ) : null}
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={value === option.value}
            onPress={() => onChange(option.value)}
          />
        ))}
      </View>
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.border,
        backgroundColor: active ? colors.primary : 'transparent',
        borderRadius: radius,
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
      }}
    >
      <Text
        style={{
          color: active ? colors.primaryForeground : colors.mutedForeground,
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The clothing-type picker, populated from the shared vocabulary. */
export function TypeSelect({
  value,
  onChange,
  label = zh.addItem.typeLabel,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  label?: string;
}) {
  const options = React.useMemo(
    () => CLOTHING_TYPES.map((type) => ({ value: type, label: clothingTypeLabel(type) })),
    [],
  );
  return (
    <ChipSelect
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      placeholder={zh.addItem.typePlaceholder}
    />
  );
}

/**
 * Multi-select colour picker.
 *
 * The server stores `colors` as an array and filters with
 * `colors.overlap(...)`, so more than one colour genuinely narrows the filter
 * correctly rather than being collapsed into a single value.
 */
export function ColorSelect({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const { colors, radius, spacing } = useTheme();

  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{zh.addItem.colorLabel}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {COLOR_CHOICES.map((value) => {
          const active = values.includes(value);
          return (
            <Pressable
              key={value}
              onPress={() => toggle(value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                borderWidth: 1,
                borderColor: active ? colors.primary : colors.border,
                backgroundColor: active ? colors.primary : 'transparent',
                borderRadius: radius,
                paddingHorizontal: spacing.md,
                paddingVertical: 6,
              }}
            >
              <Text
                style={{
                  color: active ? colors.primaryForeground : colors.mutedForeground,
                  fontSize: 13,
                }}
              >
                {colorLabel(value)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A single-line text field with an explicit label.
 *
 * `TextInput` is used directly rather than the shared `Input` because these
 * fields need `editable` to flip off while a save is in flight and need to accept
 * non-email keyboards; reusing `Input` would have meant widening its API for
 * every caller.
 */
export function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  maxLength,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  editable?: boolean;
  maxLength?: number;
  multiline?: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{label}</Text>
      <View
        style={{
          borderWidth: 1,
          borderColor: focused ? colors.ring : colors.input,
          borderRadius: radius,
          backgroundColor: colors.background,
          paddingHorizontal: spacing.md,
          opacity: editable ? 1 : 0.6,
        }}
      >
        <TextInputImpl
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          editable={editable}
          maxLength={maxLength}
          multiline={multiline}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </View>
      {maxLength ? (
        <Text style={{ color: colors.mutedForeground, fontSize: 11, textAlign: 'right' }}>
          {value.length}/{maxLength}
        </Text>
      ) : null}
    </View>
  );
}

/** Kept separate only to keep the JSX above readable. */
function TextInputImpl(props: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  editable?: boolean;
  maxLength?: number;
  multiline?: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={colors.mutedForeground}
      editable={props.editable}
      maxLength={props.maxLength}
      multiline={props.multiline}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      style={{
        color: colors.foreground,
        fontSize: 16,
        paddingVertical: spacing.md,
        minHeight: props.multiline ? 72 : undefined,
        textAlignVertical: props.multiline ? 'top' : 'center',
      }}
    />
  );
}

/** An inline warning block. Used for permission and save failures. */
export function InlineNotice({
  tone = 'destructive',
  title,
  message,
  action,
}: {
  tone?: 'destructive' | 'neutral';
  title?: string;
  message: string;
  action?: React.ReactNode;
}) {
  const { colors, radius, spacing } = useTheme();
  const accent = tone === 'destructive' ? colors.destructive : colors.border;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: accent,
        backgroundColor: tone === 'destructive' ? `${colors.destructive}14` : colors.muted,
        borderRadius: radius,
        padding: spacing.md,
        gap: spacing.xs,
      }}
    >
      {title ? (
        <Text style={{ color: accent, fontSize: 13, fontWeight: '600' }}>{title}</Text>
      ) : null}
      <Text style={{ color: tone === 'destructive' ? colors.destructive : colors.foreground, fontSize: 13 }}>
        {message}
      </Text>
      {action ? <View style={{ marginTop: spacing.sm }}>{action}</View> : null}
    </View>
  );
}

/** A horizontally scrollable preview strip for the chosen photos. */
export function PhotoStrip({
  children,
}: {
  children: React.ReactNode;
}) {
  const { spacing } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.xs }}
    >
      {children}
    </ScrollView>
  );
}

export const formStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
