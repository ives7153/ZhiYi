import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext';

/**
 * One QueryClient for the app. `retry` is tuned per-hook (auth failures must
 * never be retried); the defaults here cover everything else.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Route guard.
 *
 * Keeps the navigation tree in sync with the auth state in ONE place, instead of
 * each screen deciding whether it is allowed to render. While the stored
 * credential is being validated we show a spinner rather than either screen, so
 * the login form never flashes for a user who is actually logged in.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const { colors } = useTheme();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;

    const inAuthGroup =
      segments[0] === '(tabs)' || segments[0] === 'item' || segments[0] === 'outfit';
    const onCallback = segments[0] === 'auth';

    if (status === 'unauthenticated' && inAuthGroup) {
      router.replace('/login');
    } else if (status === 'authenticated' && !inAuthGroup && !onCallback) {
      router.replace('/(tabs)');
    }
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AuthProvider>
              <ThemedStatusBar />
              <AuthGate>
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                >
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen name="login" />
                  <Stack.Screen name="auth/callback" />
                  <Stack.Screen name="item/[id]" />
                  <Stack.Screen name="item/new" />
                  <Stack.Screen name="outfit/index" />
                  <Stack.Screen name="outfit/[id]" />
                </Stack>
              </AuthGate>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ThemedStatusBar() {
  const { isDark } = useTheme();
  return <StatusBar style={isDark ? 'light' : 'dark'} />;
}
