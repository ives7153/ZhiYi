import { Platform } from 'react-native';

/**
 * Design tokens mirrored from the Web app's `frontend/app/globals.css`.
 *
 * The Web values are HSL channel triplets consumed as `hsl(var(--token))`.
 * React Native has no CSS custom properties, so the spec converts them to hex
 * (docs/知衣-App开发规划.md §6.1). Do not "improve" these numbers — matching the
 * Web app is the requirement.
 */

export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

/** Light theme — globals.css `:root`. */
export const lightColors: ThemeColors = {
  background: '#FFFFFF', // 0 0% 100%
  foreground: '#030712', // 224 71.4% 4.1%
  card: '#FFFFFF', // 0 0% 100%
  cardForeground: '#030712',
  primary: '#111827', // 220.9 39.3% 11%
  primaryForeground: '#FAFAFA', // 210 20% 98%
  secondary: '#F3F4F6', // 220 14.3% 95.9%
  secondaryForeground: '#111827',
  muted: '#F3F4F6',
  mutedForeground: '#6B7280', // 220 8.9% 46.1%
  accent: '#F3F4F6',
  accentForeground: '#111827',
  destructive: '#EF4444', // 0 84.2% 60.2%
  destructiveForeground: '#FAFAFA',
  border: '#E5E7EB', // 220 13% 91%
  input: '#E5E7EB',
  ring: '#030712',
};

/** Dark theme — globals.css `.dark`. */
export const darkColors: ThemeColors = {
  background: '#0A0A0A', // 0 0% 3.9%
  foreground: '#FAFAFA', // 0 0% 98%
  card: '#0A0A0A',
  cardForeground: '#FAFAFA',
  primary: '#FAFAFA',
  primaryForeground: '#171717', // 0 0% 9%
  secondary: '#262626', // 0 0% 14.9%
  secondaryForeground: '#FAFAFA',
  muted: '#262626',
  mutedForeground: '#A3A3A3', // 0 0% 63.9%
  accent: '#262626',
  accentForeground: '#FAFAFA',
  destructive: '#7F1D1D', // 0 62.8% 30.6%
  destructiveForeground: '#FAFAFA',
  border: '#262626',
  input: '#262626',
  ring: '#D4D4D4', // 0 0% 83.1%
};

/** Semantic extras carried over from the Web Tailwind class names. */
export const semanticColors = {
  /** amber-500 — the needs-wash badge. */
  amber500: '#F59E0B',
  /** red-500 — the favourite heart. */
  red500: '#EF4444',
} as const;

/** Border radius: `--radius: 0.5rem` → 8. */
export const radius = 8;

/**
 * Type scale, aligned with the Tailwind classes used on the Web:
 * text-2xl/font-bold, text-sm, text-sm/font-medium, text-xs.
 */
export const typography = {
  screenTitle: { fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  subtitle: { fontSize: 14, fontWeight: '400' },
  cardTitle: { fontSize: 14, fontWeight: '500' },
  caption: { fontSize: 12, fontWeight: '400' },
} as const;

/** Icon sizes: navigation 20, in-card small icons 16. */
export const iconSizes = {
  nav: 20,
  card: 16,
  logo: 64,
} as const;

/** Spacing scale used across the screens. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Android renders elevation-based shadows; iOS uses shadow properties.
 * The Web uses `hover:shadow-md`, approximated here as `elevation: 3`.
 */
export const cardShadow = Platform.select({
  android: { elevation: 3 },
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  default: {},
});
