import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import {
  cardShadow,
  darkColors,
  iconSizes,
  lightColors,
  radius,
  semanticColors,
  spacing,
  typography,
  type ThemeColors,
} from './tokens';

/**
 * Theme follows the system appearance, matching the Web app's `next-themes`
 * setup (`ThemeProvider` with `attribute="class"`, default `system`).
 */
interface ThemeValue {
  colors: ThemeColors;
  isDark: boolean;
  radius: number;
  spacing: typeof spacing;
  typography: typeof typography;
  iconSizes: typeof iconSizes;
  semantic: typeof semanticColors;
  cardShadow: typeof cardShadow;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const value = useMemo<ThemeValue>(
    () => ({
      colors: isDark ? darkColors : lightColors,
      isDark,
      radius,
      spacing,
      typography,
      iconSizes,
      semantic: semanticColors,
      cardShadow,
    }),
    [isDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return value;
}
