import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Credential persistence.
 *
 * SECURITY CONTRACT (spec §4.2):
 *  - The `access_token` goes ONLY into `expo-secure-store` (iOS Keychain /
 *    Android Keystore).
 *  - It is NEVER written to AsyncStorage, logs, or error messages.
 *  - Only non-sensitive identity fields are cached in AsyncStorage, so the UI can
 *    show something during the startup session check without reading the token
 *    from a plaintext store.
 *
 * The token is an HS256 JWT valid for 7 days and is the user's whole session;
 * there is no refresh token to keep alongside it.
 */

const TOKEN_KEY = 'zhiyi.secure.access_token';
const PROFILE_KEY = 'zhiyi.profile';

/** Non-sensitive identity snapshot, safe for AsyncStorage. */
export interface StoredProfile {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Reads the stored access token.
 *
 * `SecureStore.getItemAsync` throws on some platforms when the keychain entry is
 * corrupt or the app was reinstalled over an old build. Treating that as "no
 * credential" is safer than crashing at startup: the user simply logs in again.
 */
export async function getStoredToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persists the access token in the platform secure store. */
export async function setStoredToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {
    // Platform has no Keychain/Keystore; keep token in memory only and never fall back to plaintext.
  }
}

/** Removes the access token from the secure store. */
export async function clearStoredToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Nothing useful to do; the in-memory token is cleared regardless.
  }
}

/** Reads the non-sensitive profile snapshot. */
export async function getStoredProfile(): Promise<StoredProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredProfile>;
    if (!parsed || typeof parsed.id !== 'string') return null;
    return {
      id: parsed.id,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
    };
  } catch {
    return null;
  }
}

/** Writes the non-sensitive profile snapshot. Never contains the token. */
export async function setStoredProfile(profile: StoredProfile): Promise<void> {
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

/** Removes the profile snapshot. */
export async function clearStoredProfile(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PROFILE_KEY);
  } catch {
    // Best effort.
  }
}

/**
 * Clears every credential this app persists.
 *
 * Deliberately does NOT touch the React Query cache: the caller clears that so
 * the two concerns stay visible at the call site (spec §4.2 requires both).
 */
export async function clearAllCredentials(): Promise<void> {
  await Promise.all([clearStoredToken(), clearStoredProfile()]);
}
