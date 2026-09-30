import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, Edit3, KeyRound, Lock, ShieldCheck, User as UserIcon } from 'lucide-react-native';
import { useQueryClient } from '@tanstack/react-query';

import { useUserProfile, userScope } from '../../src/api/hooks';
import { updateUserProfile } from '../../src/api/items';
import { useAuth } from '../../src/auth/AuthContext';
import { setStoredProfile } from '../../src/auth/storage';
import { Button, Input } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeContext';
import { apiBaseUrl, isApiConfigured } from '../../src/config/env';
import { zh } from '../../src/i18n/zh';
import { ApiError } from '../../src/api/errors';

export default function ProfileScreen() {
  const { colors, spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { signOut, user: cachedUser, changePassword, authConfig } = useAuth();
  const { data: profile, isLoading, isError } = useUserProfile();

  const [signingOut, setSigningOut] = useState(false);

  // Edit Nickname State
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Change Password State
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const displayName = profile?.display_name ?? cachedUser?.displayName ?? '—';
  const email = profile?.email ?? cachedUser?.email ?? '—';
  const isEmailVerified = profile?.email_verified ?? true;
  const isOidcUser =
    profile?.has_password === false &&
    Boolean(authConfig?.oidc.enabled || (cachedUser?.id && !profile?.has_password));
  function openEditName() {
    setNameInput(displayName === '—' ? '' : displayName);
    setNameError(null);
    setEditingName(true);
  }

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNameError('昵称不能为空');
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const updated = await updateUserProfile({ display_name: trimmed });
      // Invalidate queries and update cached profile
      const userId = cachedUser?.id ?? null;
      if (userId) {
        queryClient.setQueryData([...userScope(userId), 'profile'], updated);
      }
      if (cachedUser) {
        await setStoredProfile({
          ...cachedUser,
          displayName: updated.display_name,
        });
      }
      setEditingName(false);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : '保存失败，请重试');
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword() {
    setPasswordError(null);
    if (!oldPassword) {
      setPasswordError('请输入当前密码');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('新密码至少需要 8 个字符');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }

    setSavingPassword(true);
    try {
      await changePassword({ oldPassword, newPassword });
      setShowPasswordModal(false);
      Alert.alert('提示', zh.profile.changePasswordSuccess);
    } catch (error) {
      if (error instanceof ApiError) {
        setPasswordError(error.detail ?? '修改密码失败，请核对当前密码');
      } else if (error instanceof Error) {
        setPasswordError(error.message);
      } else {
        setPasswordError('修改密码失败，请重试');
      }
    } finally {
      setSavingPassword(false);
    }
  }

  function confirmSignOut() {
    Alert.alert(zh.profile.signOutConfirmTitle, zh.profile.signOutConfirmMessage, [
      { text: zh.profile.cancel, style: 'cancel' },
      {
        text: zh.profile.confirm,
        style: 'destructive',
        onPress: () => {
          setSigningOut(true);
          void signOut().finally(() => setSigningOut(false));
        },
      },
    ]);
  }

  const initialLetter = (displayName || email || 'Z').charAt(0).toUpperCase();

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

      {/* User Header Card */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          padding: spacing.lg,
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius,
        }}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: colors.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.primaryForeground, fontSize: 22, fontWeight: '700' }}>
            {initialLetter}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground }}>
              {isLoading ? zh.common.loading : displayName}
            </Text>
            <Pressable hitSlop={8} onPress={openEditName} style={{ padding: 2 }}>
              <Edit3 size={15} color={colors.primary} />
            </Pressable>
          </View>
          <Text style={{ fontSize: 13, color: colors.mutedForeground }}>
            {isLoading ? zh.common.loading : email}
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            backgroundColor: isEmailVerified ? '#10B9811A' : '#F59E0B1A',
            paddingVertical: 4,
            paddingHorizontal: 8,
            borderRadius: 12,
          }}
        >
          <CheckCircle2 size={13} color={isEmailVerified ? '#10B981' : '#F59E0B'} />
          <Text style={{ fontSize: 12, fontWeight: '500', color: isEmailVerified ? '#059669' : '#D97706' }}>
            {isEmailVerified ? zh.profile.verified : zh.profile.unverified}
          </Text>
        </View>
      </View>

      {/* Account Info Section */}
      <Section title={zh.profile.accountSection} description={zh.profile.accountDescription}>
        <Row
          label={zh.profile.name}
          value={isLoading ? zh.common.loading : displayName}
          first
          action={
            <Pressable hitSlop={8} onPress={openEditName}>
              <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '500' }}>
                {zh.profile.editDisplayName}
              </Text>
            </Pressable>
          }
        />
        <Row label={zh.profile.email} value={isLoading ? zh.common.loading : email} />
        <Row
          label="所在城市"
          value={isLoading ? zh.common.loading : profile?.location_name || '默认（可在搭配页切换）'}
        />
        {isError ? (
          <Row label={zh.common.error} value={zh.wardrobe.errors.loadFailed} />
        ) : null}
      </Section>

      {/* Security & Password Section */}
      <Section title={zh.profile.securitySection} description={zh.profile.securityDescription}>
        {isOidcUser ? (
          <View style={{ padding: spacing.md }}>
            <Text style={{ fontSize: 13, color: colors.mutedForeground }}>
              {zh.profile.oidcManagedNotice}
            </Text>
          </View>
        ) : (
          <Row
            label={zh.profile.changePassword}
            value="••••••••"
            first
            action={
              <Pressable
                hitSlop={8}
                onPress={() => {
                  setOldPassword('');
                  setNewPassword('');
                  setConfirmNewPassword('');
                  setPasswordError(null);
                  setShowPasswordModal(true);
                }}
              >
                <Text style={{ fontSize: 13, color: colors.primary, fontWeight: '500' }}>
                  {zh.profile.changePassword}
                </Text>
              </Pressable>
            }
          />
        )}
      </Section>

      {/* App Environment Section */}
      <Section title={zh.profile.appSection}>
        <Row
          label={zh.profile.apiBaseUrl}
          value={isApiConfigured ? (apiBaseUrl as string) : '未配置 EXPO_PUBLIC_API_URL'}
          first
        />
        <Row label={zh.profile.version} value={Constants.expoConfig?.version ?? '1.0.6'} />
      </Section>

      <Button
        title={zh.profile.signOut}
        variant="destructive"
        loading={signingOut}
        onPress={confirmSignOut}
      />

      {/* Edit Display Name Modal */}
      <Modal visible={editingName} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius },
            ]}
          >
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground, marginBottom: spacing.sm }}>
              {zh.profile.editDisplayNameTitle}
            </Text>
            {nameError ? (
              <Text style={{ color: colors.destructive, fontSize: 13, marginBottom: spacing.xs }}>
                {nameError}
              </Text>
            ) : null}
            <Input
              value={nameInput}
              onChangeText={setNameInput}
              placeholder={zh.profile.editDisplayNamePlaceholder}
              autoCapitalize="words"
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, justifyContent: 'flex-end' }}>
              <Button
                title={zh.profile.cancel}
                variant="outline"
                onPress={() => setEditingName(false)}
                disabled={savingName}
              />
              <Button
                title={zh.profile.save}
                variant="default"
                loading={savingName}
                onPress={handleSaveName}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Change Password Modal */}
      <Modal visible={showPasswordModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius, gap: spacing.sm },
            ]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <KeyRound size={18} color={colors.primary} />
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground }}>
                {zh.profile.changePassword}
              </Text>
            </View>

            {passwordError ? (
              <Text style={{ color: colors.destructive, fontSize: 13 }}>
                {passwordError}
              </Text>
            ) : null}

            <View style={{ gap: spacing.xs }}>
              <Text style={{ fontSize: 12, fontWeight: '500', color: colors.foreground }}>
                {zh.profile.oldPassword}
              </Text>
              <Input
                value={oldPassword}
                onChangeText={setOldPassword}
                placeholder="请输入当前密码"
                secureTextEntry
              />
            </View>

            <View style={{ gap: spacing.xs }}>
              <Text style={{ fontSize: 12, fontWeight: '500', color: colors.foreground }}>
                {zh.profile.newPassword}
              </Text>
              <Input
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="新密码（至少 8 位）"
                secureTextEntry
              />
            </View>

            <View style={{ gap: spacing.xs }}>
              <Text style={{ fontSize: 12, fontWeight: '500', color: colors.foreground }}>
                {zh.profile.confirmNewPassword}
              </Text>
              <Input
                value={confirmNewPassword}
                onChangeText={setConfirmNewPassword}
                placeholder="再次输入新密码"
                secureTextEntry
              />
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, justifyContent: 'flex-end' }}>
              <Button
                title={zh.profile.cancel}
                variant="outline"
                onPress={() => setShowPasswordModal(false)}
                disabled={savingPassword}
              />
              <Button
                title={zh.profile.confirm}
                variant="default"
                loading={savingPassword}
                onPress={handleChangePassword}
              />
            </View>
          </View>
        </View>
      </Modal>
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

function Row({
  label,
  value,
  first = false,
  action,
}: {
  label: string;
  value: string;
  first?: boolean;
  action?: React.ReactNode;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.border,
      }}
    >
      <Text style={{ fontSize: 14, color: colors.foreground, fontWeight: '500' }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 14, color: colors.mutedForeground, maxWidth: 200 }}
        >
          {value}
        </Text>
        {action}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    padding: 20,
    borderWidth: 1,
  },
});
