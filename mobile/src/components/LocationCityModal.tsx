import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../theme/ThemeContext";
import { useCitySearch, CitySearchItem, LocationSource } from "../api/weather";

interface LocationCityModalProps {
  visible: boolean;
  currentCity: string;
  source: LocationSource;
  onClose: () => void;
  onSelectCity: (city: CitySearchItem) => void;
  onRequestNativeLocation: () => Promise<boolean>;
}

const POPULAR_CITIES: CitySearchItem[] = [
  { name: "北京", display_name: "北京, 北京市, 中国", latitude: 39.9075, longitude: 116.3972, admin1: "北京市" },
  { name: "上海", display_name: "上海, 上海市, 中国", latitude: 31.2222, longitude: 121.4581, admin1: "上海市" },
  { name: "广州", display_name: "广州, 广东省, 中国", latitude: 23.1291, longitude: 113.2644, admin1: "广东省" },
  { name: "深圳", display_name: "深圳, 广东省, 中国", latitude: 22.5431, longitude: 114.0579, admin1: "广东省" },
  { name: "杭州", display_name: "杭州, 浙江省, 中国", latitude: 30.2741, longitude: 120.1551, admin1: "浙江省" },
  { name: "成都", display_name: "成都, 四川省, 中国", latitude: 30.5728, longitude: 104.0668, admin1: "四川省" },
];

export function LocationCityModal({
  visible,
  currentCity,
  source,
  onClose,
  onSelectCity,
  onRequestNativeLocation,
}: LocationCityModalProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState("");
  const [locating, setLocating] = useState(false);

  const { data: searchResults, isLoading: searching } = useCitySearch(query);

  const handleUseGps = async () => {
    setLocating(true);
    await onRequestNativeLocation();
    setLocating(false);
    onClose();
  };

  const sourceLabel = {
    gps: "本机真实 GPS",
    simulated: "模拟器注入位置",
    manual: "手动选择城市",
    none: "默认位置",
  }[source] || "未知";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable style={styles.dismissArea} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              paddingBottom: Math.max(insets.bottom, 20),
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
            },
          ]}
        >
          {/* Header */}
          <View style={styles.sheetHeader}>
            <Text style={[styles.title, { color: colors.foreground }]}>选择所在城市</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: colors.mutedForeground, fontSize: 15 }}>关闭</Text>
            </Pressable>
          </View>

          {/* Current City & Source Badge */}
          <View style={[styles.currentBox, { backgroundColor: colors.card, borderRadius: radius }]}>
            <Text style={[styles.currentLabel, { color: colors.mutedForeground }]}>当前城市：</Text>
            <Text style={[styles.cityName, { color: colors.foreground }]}>{currentCity}</Text>
            <View style={[styles.sourceBadge, { backgroundColor: colors.muted }]}>
              <Text style={[styles.sourceText, { color: colors.primary }]}>{sourceLabel}</Text>
            </View>
          </View>

          {/* GPS Button */}
          <Pressable
            onPress={handleUseGps}
            style={[styles.gpsButton, { backgroundColor: colors.primary, borderRadius: radius }]}
          >
            {locating ? (
              <ActivityIndicator color={colors.primaryForeground} size="small" />
            ) : (
              <Text style={[styles.gpsButtonText, { color: colors.primaryForeground }]}>📍 使用当前定位 (GPS/基站)</Text>
            )}
          </Pressable>

          {/* Search Input */}
          <View
            style={[
              styles.searchBox,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: radius,
              },
            ]}
          >
            <TextInput
              style={[styles.searchInput, { color: colors.foreground }]}
              value={query}
              onChangeText={setQuery}
              placeholder="输入城市名称搜索 (如: 北京, 深圳...)"
              placeholderTextColor={colors.mutedForeground}
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            {searching ? <ActivityIndicator size="small" color={colors.primary} /> : null}
          </View>

          {/* Results or Popular Cities */}
          {query.trim().length > 0 ? (
            <FlatList
              data={searchResults ?? []}
              keyExtractor={(item, idx) => `${item.latitude}_${item.longitude}_${idx}`}
              style={{ maxHeight: 220 }}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    onSelectCity(item);
                    onClose();
                  }}
                  style={[styles.cityRow, { borderColor: colors.border }]}
                >
                  <Text style={[styles.cityRowName, { color: colors.foreground }]}>
                    {item.display_name}
                  </Text>
                </Pressable>
              )}
              ListEmptyComponent={
                !searching ? (
                  <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                    未搜到匹配城市
                  </Text>
                ) : null
              }
            />
          ) : (
            <View style={styles.popularSection}>
              <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>热门城市</Text>
              <View style={styles.chipRow}>
                {POPULAR_CITIES.map((c) => (
                  <Pressable
                    key={c.name}
                    onPress={() => {
                      onSelectCity(c);
                      onClose();
                    }}
                    style={[
                      styles.cityChip,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        borderRadius: radius,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: colors.foreground }]}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    justifyContent: "flex-end",
  },
  dismissArea: {
    flex: 1,
  },
  sheet: {
    paddingTop: 16,
    paddingHorizontal: 20,
    maxHeight: "80%",
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
  },
  currentBox: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  currentLabel: {
    fontSize: 13,
  },
  cityName: {
    fontSize: 15,
    fontWeight: "700",
  },
  sourceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: "auto",
  },
  sourceText: {
    fontSize: 11,
    fontWeight: "600",
  },
  gpsButton: {
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  gpsButtonText: {
    fontSize: 14,
    fontWeight: "600",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },
  cityRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cityRowName: {
    fontSize: 14,
  },
  emptyText: {
    paddingVertical: 20,
    textAlign: "center",
    fontSize: 13,
  },
  popularSection: {
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  cityChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
  },
});
