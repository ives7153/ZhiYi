import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Item, OutfitItem } from "../../src/api/types";
import { clothingTypeLabel } from "../../src/api/itemVocab";
import { ApiError, NetworkError } from "../../src/api/errors";
import { useItem, useItemTypes } from "../../src/api/hooks";
import {
  useCreateOutfit,
  useFullBodyCandidates,
  useSlotCandidates,
  useSuggestOutfit,
} from "../../src/api/outfitHooks";
import {
  DEFAULT_OUTFIT_OCCASION,
  OUTFIT_NAME_MAX_LENGTH,
  SLOTS,
  SLOT_LABELS,
  UNSUPPORTED_FULL_BODY_TYPES,
  isUnclassified,
  slotForType,
  type SlotKey,
} from "../../src/api/outfitVocab";
import {
  draftBlocker,
  draftHasToBuy,
  draftItemIds,
  draftItemOverflow,
  draftToBuyGarmentIds,
  emptyDraft,
  isDraftEmpty,
  missingRequiredSlots,
  outfitItemAsItem,
  type OutfitDraft,
} from "../../src/outfits/draft";
import { Button } from "../../src/components/ui";
import { ItemPickerSheet } from "../../src/components/ItemPickerSheet";
import { ConfirmDialog } from "../../src/components/ConfirmDialog";
import { OutfitCanvasZone } from "../../src/components/OutfitCanvasZone";
import { LocationCityModal } from "../../src/components/LocationCityModal";
import { useTheme } from "../../src/theme/ThemeContext";
import { zh } from "../../src/i18n/zh";
import {
  CitySearchItem,
  useDeviceLocation,
  useWeather,
} from "../../src/api/weather";
import { OWNED, TO_BUY } from "../../src/api/toBuy";

const OCCASIONS = [
  { key: "casual", label: "日常" },
  { key: "work", label: "工作" },
  { key: "party", label: "聚会" },
  { key: "formal", label: "正式" },
  { key: "sports", label: "运动" },
];

export default function OutfitsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, spacing, radius } = useTheme();

  const { trialItemId } = useLocalSearchParams<{ trialItemId?: string }>();
  const trialId = typeof trialItemId === "string" && trialItemId ? trialItemId : null;

  const [draft, setDraft] = useState<OutfitDraft>(emptyDraft);
  const [selectedOccasion, setSelectedOccasion] = useState<string>("casual");
  const [isFullBodyMode, setIsFullBodyMode] = useState<boolean>(false);
  const [fullBodyGarment, setFullBodyGarment] = useState<Item | null>(null);

  const [pickerSlot, setPickerSlot] = useState<SlotKey | null>(null);
  const [pickerIsFullBody, setPickerIsFullBody] = useState<boolean>(false);

  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [trialBlocked, setTrialBlocked] = useState<string | null>(null);

  // AI Recommendation feedback
  const [aiReasoning, setAiReasoning] = useState<string | null>(null);
  const [aiErrorNotice, setAiErrorNotice] = useState<string | null>(null);

  // Location & Weather
  const {
    city,
    latitude,
    longitude,
    source: locationSource,
    requestNativeLocation,
    setManualCity,
  } = useDeviceLocation();

  const { data: weather, isLoading: weatherLoading } = useWeather(
    latitude !== null && longitude !== null ? { latitude, longitude } : null
  );

  const createOutfit = useCreateOutfit();
  const suggestOutfitMutation = useSuggestOutfit();
  const { data: trialItem, isError: trialFailed } = useItem(trialId);
  const { data: typeCounts } = useItemTypes();
  const notes = useMemo(() => {
    const counts = typeCounts ?? [];
    const unclassified = counts
      .filter((entry) => isUnclassified(entry.type))
      .reduce((sum, entry) => sum + entry.count, 0);
    const fullBody = counts
      .filter((entry) => UNSUPPORTED_FULL_BODY_TYPES.includes(entry.type))
      .reduce((sum, entry) => sum + entry.count, 0);
    return { unclassified, fullBody };
  }, [typeCounts]);

  // Candidate queries for each slot — normal wardrobe candidates are always owned
  const isTrial = draftHasToBuy(draft) || Boolean(trialId);

  const topQuery = useSlotCandidates("top", "", OWNED);
  const bottomQuery = useSlotCandidates("bottom", "", OWNED);
  const shoesQuery = useSlotCandidates("shoes", "", OWNED);
  const outerQuery = useSlotCandidates("outer", "", OWNED);
  const accessoryQuery = useSlotCandidates("accessory", "", OWNED);
  const fullBodyQuery = useFullBodyCandidates("", OWNED);

  const topCandidates = topQuery.data?.items ?? [];
  const bottomCandidates = bottomQuery.data?.items ?? [];
  const shoesCandidates = shoesQuery.data?.items ?? [];
  const outerCandidates = outerQuery.data?.items ?? [];
  const accessoryCandidates = accessoryQuery.data?.items ?? [];
  const fullBodyCandidates = fullBodyQuery.data?.items ?? [];



  // Handle trial garment placement
  const appliedTrialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!trialId) {
      appliedTrialRef.current = null;
      setTrialBlocked(null);
      return;
    }
    if (!trialItem || appliedTrialRef.current === trialItem.id) return;
    appliedTrialRef.current = trialItem.id;

    if (trialItem.type === "dress" || trialItem.type === "jumpsuit") {
      setIsFullBodyMode(true);
      setFullBodyGarment(trialItem);
      setTrialBlocked(null);
      return;
    }

    const slot = slotForType(trialItem.type);
    if (!slot) {
      setTrialBlocked(zh.outfits.trialModeCannotPlace);
      return;
    }
    setTrialBlocked(null);
    setIsFullBodyMode(false);
    setDraft((current) => ({
      ...current,
      selection: { ...current.selection, [slot]: trialItem },
    }));
  }, [trialId, trialItem]);

  const setSlot = useCallback((slot: SlotKey, garment: Item | null) => {
    setDraft((current) => {
      const nextSelection = { ...current.selection };
      if (!garment) {
        delete nextSelection[slot];
      } else {
        nextSelection[slot] = garment;
      }
      return { ...current, selection: nextSelection };
    });
    setSaveError(null);
    setSaveUncertain(false);
  }, []);

  const handleSelectFullBody = useCallback((item: Item) => {
    setFullBodyGarment(item);
    setIsFullBodyMode(true);
    setSaveError(null);
    setSaveUncertain(false);
  }, []);

  // Compute final item IDs for saving
  const currentItemIds = useMemo(() => {
    const ids: string[] = [];
    if (isFullBodyMode && fullBodyGarment) {
      ids.push(fullBodyGarment.id);
    } else {
      if (draft.selection.top) ids.push(draft.selection.top.id);
      if (draft.selection.bottom) ids.push(draft.selection.bottom.id);
    }
    if (draft.selection.shoes) ids.push(draft.selection.shoes.id);
    if (draft.selection.outer) ids.push(draft.selection.outer.id);
    if (draft.selection.accessory) ids.push(draft.selection.accessory.id);
    for (const p of draft.passthrough) {
      if (!ids.includes(p.id)) ids.push(p.id);
    }
    return ids;
  }, [draft, isFullBodyMode, fullBodyGarment]);

  // AI Recommendation Trigger
  const handleAiSuggest = useCallback(async () => {
    setAiReasoning(null);
    setAiErrorNotice(null);
    try {
      const weatherOverride = weather
        ? {
            temperature: weather.temperature,
            condition: weather.condition,
            feels_like: weather.feels_like,
            humidity: weather.humidity,
            precipitation_chance: weather.precipitation_chance,
          }
        : undefined;

      const outfit = await suggestOutfitMutation.mutateAsync({
        occasion: selectedOccasion,
        time_of_day: "afternoon",
        weather_override: weatherOverride,
      });

      // Apply returned outfit items
      let hasFullBody = false;
      let newFullBody: Item | null = null;
      const newSelection: Partial<Record<SlotKey, Item>> = {};

      for (const oi of outfit.items) {
        const itemType = oi.type;
        if (itemType === "dress" || itemType === "jumpsuit") {
          hasFullBody = true;
          newFullBody = outfitItemAsItem(oi);
        } else {
          const slot = slotForType(itemType);
          if (slot) {
            newSelection[slot] = outfitItemAsItem(oi);
          }
        }
      }

      if (hasFullBody && newFullBody) {
        setIsFullBodyMode(true);
        setFullBodyGarment(newFullBody);
      } else {
        setIsFullBodyMode(false);
      }
      setDraft((current) => ({
        ...current,
        selection: { ...current.selection, ...newSelection },
      }));

      const reasoning =
        outfit.reasoning ||
        `已结合${city || "当地"}${weather ? `${weather.temperature}°C ${weather.condition}` : ""}及${
          OCCASIONS.find((o) => o.key === selectedOccasion)?.label || "日常"
        }场合，为你生成搭配。`;
      setAiReasoning(reasoning);
    } catch (err: any) {
      const msg = err?.detail || err?.message || "AI 服务暂不可用";
      setAiErrorNotice(msg.includes("AI_BASE_URL") || msg.includes("not configured")
        ? "AI 服务暂未就绪（后端未配置模型密钥），已保留手动滑动搭配。"
        : `AI 推荐请求失败: ${msg}`);
    }
  }, [city, selectedOccasion, suggestOutfitMutation, weather]);

  // "换一套" Random / Cycle Shuffle
  const handleShuffleOutfit = useCallback(() => {
    setAiReasoning(null);
    setAiErrorNotice(null);
    if (isFullBodyMode) {
      if (fullBodyCandidates.length > 1) {
        const next = fullBodyCandidates.find((c) => c.id !== fullBodyGarment?.id);
        if (next) setFullBodyGarment(next);
      }
    } else {
      if (topCandidates.length > 1) {
        const nextTop = topCandidates.find((c) => c.id !== draft.selection.top?.id);
        if (nextTop) setSlot("top", nextTop);
      }
      if (bottomCandidates.length > 1) {
        const nextBottom = bottomCandidates.find((c) => c.id !== draft.selection.bottom?.id);
        if (nextBottom) setSlot("bottom", nextBottom);
      }
    }
    if (shoesCandidates.length > 1) {
      const nextShoes = shoesCandidates.find((c) => c.id !== draft.selection.shoes?.id);
      if (nextShoes) setSlot("shoes", nextShoes);
    }
  }, [
    isFullBodyMode,
    fullBodyCandidates,
    fullBodyGarment?.id,
    topCandidates,
    bottomCandidates,
    shoesCandidates,
    draft.selection.top?.id,
    draft.selection.bottom?.id,
    draft.selection.shoes?.id,
    setSlot,
  ]);

  const [name, setName] = useState<string>("");



  const defaultOutfitName = `${city || "今日"}${
    OCCASIONS.find((o) => o.key === selectedOccasion)?.label || "日常"
  }穿搭`;

  // Direct Save Outfit
  const handleDirectSave = useCallback(async () => {
    setSaveError(null);
    setSaveUncertain(false);

    const nameTrimmed = name.trim();
    const nameTooLong = nameTrimmed.length > OUTFIT_NAME_MAX_LENGTH;

    if (currentItemIds.length === 0) {
      setSaveError(zh.outfits.saveNeedsItem);
      return;
    }
    if (nameTooLong) {
      setSaveError(zh.outfits.saveNameTooLong(OUTFIT_NAME_MAX_LENGTH));
      return;
    }

    const overflow = draftItemOverflow(draft);
    if (overflow) {
      setSaveError(zh.outfits.saveTooManyItems(overflow.total, overflow.max, overflow.excess));
      return;
    }

    try {
      const outfit = await createOutfit.mutateAsync({
        items: currentItemIds,
        occasion: selectedOccasion,
        name: nameTrimmed || defaultOutfitName,
      });

      setDraft(emptyDraft());
      setFullBodyGarment(null);
      setName("");
      router.push(`/outfit/${outfit.id}`);
    } catch (error) {
      if (error instanceof NetworkError) {
        if (error.outcomeUnknown) {
          setSaveUncertain(true);
          setSaveError(zh.outfits.saveUncertainMessage);
          return;
        }
        setSaveError(error.message);
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        setSaveError(zh.outfits.saveItemUnavailable);
        return;
      }
      setSaveError(error instanceof ApiError && error.detail ? error.detail : zh.outfits.saveFailed);
    }
  }, [createOutfit, currentItemIds, defaultOutfitName, draft, name, router, selectedOccasion]);

  // Hardware back press protection
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (locationModalVisible || saveModalVisible || pickerSlot || pickerIsFullBody) {
        return false;
      }
      if (currentItemIds.length > 0) {
        setConfirmLeave(true);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [currentItemIds.length, locationModalVisible, saveModalVisible, pickerSlot, pickerIsFullBody]);


  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + spacing.sm,
            paddingBottom: insets.bottom + spacing.xl,
            paddingHorizontal: spacing.md,
          },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Top Header Bar: Weather + Occasion + Saved Link */}
        <View style={styles.topHeader}>
          {/* Weather & Location Pill */}
          <Pressable
            onPress={() => setLocationModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="切换城市或定位"
            style={[styles.weatherPill, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.weatherIcon, { color: colors.primary }]}>📍</Text>
            <Text style={[styles.weatherCity, { color: colors.foreground }]}>{city}</Text>
            {weather ? (
              <Text style={[styles.weatherTemp, { color: colors.mutedForeground }]}>
                {Math.round(weather.temperature)}°C {weather.condition}
              </Text>
            ) : (
              <Text style={[styles.weatherTemp, { color: colors.mutedForeground }]}>
                {weatherLoading ? "加载天气..." : "获取天气"}
              </Text>
            )}
            <Text style={[styles.weatherArrow, { color: colors.mutedForeground }]}>▾</Text>
          </Pressable>

          {/* Saved Outfits Link */}
          <Pressable
            onPress={() => router.push("/outfit")}
            accessibilityRole="button"
            accessibilityLabel="已保存搭配"
            hitSlop={8}
            style={[styles.savedLink, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.savedLinkText, { color: colors.foreground }]}>已保存搭配</Text>
          </Pressable>
        </View>

        {/* Occasions Row */}
        <View style={styles.occasionsRow}>
          {OCCASIONS.map((occ) => {
            const isSelected = selectedOccasion === occ.key;
            return (
              <Pressable
                key={occ.key}
                onPress={() => setSelectedOccasion(occ.key)}
                accessibilityRole="button"
                accessibilityLabel={occ.label}
                style={[
                  styles.occasionChip,
                  {
                    backgroundColor: isSelected ? colors.primary : colors.card,
                    borderColor: isSelected ? colors.primary : colors.border,
                    borderRadius: radius,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.occasionText,
                    {
                      color: isSelected ? "#FFFFFF" : colors.foreground,
                      fontWeight: isSelected ? "700" : "500",
                    },
                  ]}
                >
                  {occ.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Trial Mode Badge */}
        {isTrial ? (
          <View style={[styles.trialBadgeBox, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B" }]}>
            <Text style={styles.trialBadgeText}>🏷️ 试搭·含待购单品（不计入穿着统计）</Text>
          </View>
        ) : null}

        {/* AI Reasoning Bubble */}
        {aiReasoning ? (
          <View
            style={[
              styles.reasoningBubble,
              {
                backgroundColor: colors.card,
                borderColor: colors.primary,
                borderRadius: radius,
              },
            ]}
          >
            <Text style={[styles.reasoningTitle, { color: colors.primary }]}>✨ AI 搭配建议</Text>
            <Text style={[styles.reasoningContent, { color: colors.foreground }]}>
              {aiReasoning}
            </Text>
          </View>
        ) : null}

        {/* AI Error / Degradation Notice */}
        {aiErrorNotice ? (
          <View
            style={[
              styles.aiNoticeBox,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius },
            ]}
          >
            <Text style={[styles.aiNoticeText, { color: colors.mutedForeground }]}>
              {aiErrorNotice}
            </Text>
          </View>
        ) : null}

        {/* Compact reminders for unclassified and full-body mode */}
        {notes.unclassified > 0 ? (
          <View style={[styles.compactNotice, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius }]}>
            <Text style={[styles.compactNoticeText, { color: colors.mutedForeground }]}>
              另有 {notes.unclassified} 件单品属于「待分类」
            </Text>
          </View>
        ) : null}

        {notes.fullBody > 0 && !isFullBodyMode ? (
          <View style={[styles.compactNotice, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius }]}>
            <Text style={[styles.compactNoticeText, { color: colors.mutedForeground }]}>
              连衣裙、连体衣暂不支持搭配席位，可点上方「连体裙」切换
            </Text>
          </View>
        ) : null}

        {/* Main Outfit Canvas Container */}
        <View
          style={[
            styles.canvasContainer,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: 24,
            },
          ]}
        >
          {/* Canvas Toolbar: Mode Switch + Outer/Accessory */}
          <View style={styles.canvasToolbar}>
            {/* Mode Switcher */}
            <View style={[styles.modeSwitch, { backgroundColor: colors.background, borderRadius: radius }]}>
              <Pressable
                onPress={() => setIsFullBodyMode(false)}
                style={[
                  styles.modeBtn,
                  !isFullBodyMode && { backgroundColor: colors.primary, borderRadius: radius - 2 },
                ]}
              >
                <Text
                  style={[
                    styles.modeBtnText,
                    { color: !isFullBodyMode ? "#FFFFFF" : colors.mutedForeground },
                  ]}
                >
                  分体搭
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setIsFullBodyMode(true)}
                style={[
                  styles.modeBtn,
                  isFullBodyMode && { backgroundColor: colors.primary, borderRadius: radius - 2 },
                ]}
              >
                <Text
                  style={[
                    styles.modeBtnText,
                    { color: isFullBodyMode ? "#FFFFFF" : colors.mutedForeground },
                  ]}
                >
                  连体裙
                </Text>
              </Pressable>
            </View>

            {/* Outer & Accessory quick chips */}
            <View style={styles.quickAccessoryRow}>
              <Pressable
                onPress={() => {
                  setPickerSlot("outer");
                  setPickerIsFullBody(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  draft.selection.outer
                    ? `更换外套：${draft.selection.outer.name || "外套"}`
                    : outerCandidates.length === 0
                    ? zh.outfits.slotNoItems("外套")
                    : "选择外套单品"
                }
                style={[
                  styles.accessoryPill,
                  {
                    backgroundColor: draft.selection.outer ? colors.primary + "18" : colors.background,
                    borderColor: draft.selection.outer ? colors.primary : colors.border,
                    borderRadius: radius,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.accessoryPillText,
                    { color: draft.selection.outer ? colors.primary : colors.mutedForeground },
                  ]}
                >
                  {draft.selection.outer
                    ? `🧥 ${draft.selection.outer.name || "外套"}`
                    : outerCandidates.length === 0
                    ? zh.outfits.slotNoItems("外套")
                    : "+ 外套"}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  setPickerSlot("accessory");
                  setPickerIsFullBody(false);
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  draft.selection.accessory
                    ? `更换配饰：${draft.selection.accessory.name || "配饰"}`
                    : "选择配饰单品"
                }
                style={[
                  styles.accessoryPill,
                  {
                    backgroundColor: draft.selection.accessory ? colors.primary + "18" : colors.background,
                    borderColor: draft.selection.accessory ? colors.primary : colors.border,
                    borderRadius: radius,
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.accessoryPillText,
                    { color: draft.selection.accessory ? colors.primary : colors.mutedForeground },
                  ]}
                >
                  {draft.selection.accessory
                    ? `🧣 ${draft.selection.accessory.name || "配饰"}`
                    : "+ 配饰"}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Visual Zones */}
          {!isFullBodyMode ? (
            <>
              {/* Zone 1: Upper Garment (上衣) */}
              <OutfitCanvasZone
                zoneKey="top"
                label="上衣"
                required
                height={175}
                garment={draft.selection.top ?? null}
                candidates={
                  draft.selection.top && !topCandidates.some((c) => c.id === draft.selection.top?.id)
                    ? [draft.selection.top, ...topCandidates]
                    : topCandidates
                }
                isLoading={topQuery.isLoading}
                onSelect={(item) => setSlot("top", item)}
                onOpenPicker={() => {
                  setPickerSlot("top");
                  setPickerIsFullBody(false);
                }}
              />

              {/* Zone 2: Lower Garment (下装) */}
              <OutfitCanvasZone
                zoneKey="bottom"
                label="下装"
                required
                height={210}
                garment={draft.selection.bottom ?? null}
                candidates={
                  draft.selection.bottom && !bottomCandidates.some((c) => c.id === draft.selection.bottom?.id)
                    ? [draft.selection.bottom, ...bottomCandidates]
                    : bottomCandidates
                }
                isLoading={bottomQuery.isLoading}
                onSelect={(item) => setSlot("bottom", item)}
                onOpenPicker={() => {
                  setPickerSlot("bottom");
                  setPickerIsFullBody(false);
                }}
              />

              {/* Zone 3: Footwear (鞋子) */}
              <OutfitCanvasZone
                zoneKey="shoes"
                label="鞋子"
                required
                height={115}
                garment={draft.selection.shoes ?? null}
                candidates={shoesCandidates}
                isLoading={shoesQuery.isLoading}
                onSelect={(item) => setSlot("shoes", item)}
                onOpenPicker={() => {
                  setPickerSlot("shoes");
                  setPickerIsFullBody(false);
                }}
              />
            </>
          ) : (
            <>
              {/* Zone 1: Full-Body (连体衣/裙) */}
              <OutfitCanvasZone
                zoneKey="full_body"
                label="连体衣/裙"
                required
                height={340}
                garment={fullBodyGarment}
                candidates={fullBodyCandidates}
                isLoading={fullBodyQuery.isLoading}
                onSelect={handleSelectFullBody}
                onOpenPicker={() => {
                  setPickerSlot("top");
                  setPickerIsFullBody(true);
                }}
              />

              {/* Zone 2: Footwear (鞋子) */}
              <OutfitCanvasZone
                zoneKey="shoes"
                label="鞋子"
                required
                height={115}
                garment={draft.selection.shoes ?? null}
                candidates={shoesCandidates}
                isLoading={shoesQuery.isLoading}
                onSelect={(item) => setSlot("shoes", item)}
                onOpenPicker={() => {
                  setPickerSlot("shoes");
                  setPickerIsFullBody(false);
                }}
              />
            </>
          )}
        </View>

        {/* Save Error Box */}
        {saveError ? (
          <View style={[styles.errorBox, { borderColor: colors.destructive, borderRadius: radius }]}>
            <Text style={{ color: colors.destructive, fontWeight: "600", fontSize: 13, marginBottom: 2 }}>
              {zh.outfits.saveFailedTitle}
            </Text>
            <Text style={{ color: colors.destructive, fontSize: 13 }}>{saveError}</Text>
          </View>
        ) : null}

        {/* Compact Name Row (Secondary Affordance) */}
        <View style={styles.nameRow}>
          <Text style={[styles.nameLabel, { color: colors.mutedForeground }]}>搭配名称：</Text>
          <TextInput
            style={[
              styles.nameInput,
              {
                color: colors.foreground,
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: radius,
              },
            ]}
            value={name}
            onChangeText={setName}
            placeholder={zh.outfits.namePlaceholder}
            placeholderTextColor={colors.mutedForeground}
            maxLength={OUTFIT_NAME_MAX_LENGTH}
          />
        </View>

        {/* Bottom Action Bar */}
        <View style={styles.bottomActionBar}>
          {/* Main Primary CTA: AI 帮我搭 */}
          <Pressable
            onPress={handleAiSuggest}
            disabled={suggestOutfitMutation.isPending}
            accessibilityRole="button"
            accessibilityLabel="AI 帮我搭"
            style={[
              styles.aiPrimaryBtn,
              { backgroundColor: colors.primary, borderRadius: radius },
            ]}
          >
            {suggestOutfitMutation.isPending ? (
              <View style={styles.btnRow}>
                <ActivityIndicator color="#FFFFFF" size="small" />
                <Text style={styles.aiPrimaryText}>AI 搭配中...</Text>
              </View>
            ) : (
              <Text style={styles.aiPrimaryText}>✨ AI 帮我搭</Text>
            )}
          </Pressable>

          <View style={styles.secondaryBtnRow}>
            {/* 换一套 */}
            <Pressable
              onPress={handleShuffleOutfit}
              accessibilityRole="button"
              accessibilityLabel="换一套"
              style={[
                styles.secondaryBtn,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius },
              ]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>🔄 换一套</Text>
            </Pressable>

            {/* 保存搭配 / 保存试搭 */}
            <Pressable
              onPress={handleDirectSave}
              disabled={createOutfit.isPending}
              accessibilityRole="button"
              accessibilityLabel={isTrial ? "保存试搭" : "保存搭配"}
              style={[
                styles.secondaryBtn,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radius },
              ]}
            >
              {createOutfit.isPending ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>
                  💾 {isTrial ? "保存试搭" : "保存搭配"}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {/* Item Picker Bottom Sheet */}
      {pickerSlot ? (
        <ItemPickerSheet
          visible={Boolean(pickerSlot)}
          slot={pickerSlot}
          isFullBody={pickerIsFullBody}
          selectedId={
            pickerIsFullBody
              ? fullBodyGarment?.id ?? null
              : draft.selection[pickerSlot]?.id ?? null
          }
          allowToBuy={isTrial}
          onSelect={(item) => {
            if (pickerIsFullBody) {
              handleSelectFullBody(item);
            } else {
              setSlot(pickerSlot, item);
            }
            setPickerSlot(null);
            setPickerIsFullBody(false);
          }}
          onClose={() => {
            setPickerSlot(null);
            setPickerIsFullBody(false);
          }}
        />
      ) : null}

      {/* Location & City Modal */}
      <LocationCityModal
        visible={locationModalVisible}
        currentCity={city}
        source={locationSource}
        onClose={() => setLocationModalVisible(false)}
        onSelectCity={(c) => setManualCity(c)}
        onRequestNativeLocation={requestNativeLocation}
      />


      {/* Confirm Leave Guard */}
      <ConfirmDialog
        visible={confirmLeave}
        title={zh.outfits.leaveTitle}
        message={zh.outfits.leaveMessage}
        confirmLabel={zh.outfits.leaveConfirm}
        cancelLabel={zh.outfits.keepEditing}
        destructive
        onConfirm={() => {
          setConfirmLeave(false);
          setDraft(emptyDraft());
          setFullBodyGarment(null);
          BackHandler.exitApp();
        }}
        onCancel={() => setConfirmLeave(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scrollContent: {
    gap: 12,
  },
  topHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  weatherPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  weatherIcon: {
    fontSize: 13,
  },
  weatherCity: {
    fontSize: 13,
    fontWeight: "700",
  },
  weatherTemp: {
    fontSize: 12,
  },
  weatherArrow: {
    fontSize: 10,
  },
  savedLink: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  savedLinkText: {
    fontSize: 12,
    fontWeight: "600",
  },
  occasionsRow: {
    flexDirection: "row",
    gap: 8,
  },
  occasionChip: {
    flex: 1,
    paddingVertical: 7,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  occasionText: {
    fontSize: 12,
  },
  trialBadgeBox: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  trialBadgeText: {
    color: "#B45309",
    fontSize: 12,
    fontWeight: "600",
  },
  reasoningBubble: {
    padding: 12,
    borderWidth: 1,
    gap: 4,
  },
  reasoningTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  reasoningContent: {
    fontSize: 13,
    lineHeight: 18,
  },
  aiNoticeBox: {
    padding: 10,
    borderWidth: 1,
  },
  aiNoticeText: {
    fontSize: 12,
    textAlign: "center",
  },
  compactNotice: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  compactNoticeText: {
    fontSize: 12,
  },
  canvasContainer: {
    width: "100%",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
  canvasToolbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  modeSwitch: {
    flexDirection: "row",
    padding: 2,
  },
  modeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  modeBtnText: {
    fontSize: 11,
    fontWeight: "600",
  },
  quickAccessoryRow: {
    flexDirection: "row",
    gap: 6,
  },
  accessoryPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    maxWidth: 100,
  },
  accessoryPillText: {
    fontSize: 11,
    fontWeight: "500",
  },
  errorBox: {
    borderWidth: 1,
    padding: 10,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
    marginBottom: 4,
  },
  nameLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  nameInput: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
  },
  bottomActionBar: {
    marginTop: 6,
    gap: 10,
  },
  aiPrimaryBtn: {
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#4F46E5",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  btnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  aiPrimaryText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  secondaryBtnRow: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
