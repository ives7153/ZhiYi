import { Tabs } from 'expo-router';
import { LayoutGrid, Settings, Shirt, ShoppingBag } from 'lucide-react-native';

import { useTheme } from '../../src/theme/ThemeContext';
import { zh } from '../../src/i18n/zh';

/**
 * Four bottom tabs, in the exact order required by the spec:
 * 衣橱 (Shirt) → 搭配 (LayoutGrid) → 待购 (ShoppingBag) → 我的 (Settings).
 *
 * Visuals follow the Web `MobileNav`: a 1px top border, the labels below the
 * icons in text-xs, primary for the active entry and muted-foreground otherwise.
 */
export default function TabsLayout() {
  const { colors, iconSizes, typography } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          height: 64,
          paddingTop: 6,
          paddingBottom: 6,
        },
        tabBarLabelStyle: {
          fontSize: typography.caption.fontSize,
          fontWeight: '400',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: zh.nav.wardrobe,
          tabBarIcon: ({ color }) => <Shirt size={iconSizes.nav} color={color} />,
        }}
      />
      <Tabs.Screen
        name="outfits"
        options={{
          title: zh.nav.outfits,
          tabBarIcon: ({ color }) => <LayoutGrid size={iconSizes.nav} color={color} />,
        }}
      />
      <Tabs.Screen
        name="to-buy"
        options={{
          title: zh.nav.toBuy,
          tabBarIcon: ({ color }) => <ShoppingBag size={iconSizes.nav} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: zh.nav.profile,
          tabBarIcon: ({ color }) => <Settings size={iconSizes.nav} color={color} />,
        }}
      />
    </Tabs>
  );
}
