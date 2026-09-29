import { useState, useEffect, useCallback } from "react";
import * as Location from "expo-location";
import { useQuery } from "@tanstack/react-query";
import { request } from "./client";
import { userScope } from "./hooks";
import { useAuth } from "../auth/AuthContext";

export interface WeatherResponse {
  temperature: number;
  feels_like: number;
  humidity: number;
  precipitation_chance: number;
  precipitation_mm: number;
  wind_speed: number;
  condition: string;
  condition_code: number;
  is_day: boolean;
  uv_index: number;
  timestamp: string;
  temp_min?: number | null;
  temp_max?: number | null;
}

export interface CitySearchItem {
  name: string;
  display_name: string;
  latitude: number;
  longitude: number;
  country?: string | null;
  admin1?: string | null;
}

export type LocationSource = "gps" | "manual" | "simulated" | "none";

export interface LocationState {
  city: string;
  latitude: number | null;
  longitude: number | null;
  source: LocationSource;
  error?: string | null;
}

/** GET /api/v1/weather/current */
export function getCurrentWeather(
  coords?: { latitude: number; longitude: number } | null,
  signal?: AbortSignal,
): Promise<WeatherResponse> {
  const params: Record<string, string | number> = {};
  if (coords) {
    params.latitude = coords.latitude;
    params.longitude = coords.longitude;
  }
  return request<WeatherResponse>("/weather/current", { params, signal });
}

/** GET /api/v1/weather/cities */
export function searchCities(
  query: string,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<CitySearchItem[]> {
  return request<CitySearchItem[]>("/weather/cities", {
    params: { query: query.trim(), limit },
    signal,
  });
}

/** Hook for fetching current weather */
export function useWeather(coords: { latitude: number; longitude: number } | null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  return useQuery<WeatherResponse, Error>({
    queryKey: [...userScope(userId), "weather", coords?.latitude, coords?.longitude],
    enabled: Boolean(userId) && Boolean(coords && coords.latitude !== null && coords.longitude !== null),
    queryFn: ({ signal }) => getCurrentWeather(coords, signal),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
}

/** Hook for searching cities */
export function useCitySearch(query: string) {
  const trimmed = query.trim();
  return useQuery<CitySearchItem[], Error>({
    queryKey: ["city-search", trimmed],
    enabled: trimmed.length >= 1,
    queryFn: ({ signal }) => searchCities(trimmed, 10, signal),
    staleTime: 60 * 60 * 1000,
  });
}

const DEFAULT_COORDS = {
  city: "上海",
  latitude: 31.2222,
  longitude: 121.4581,
};

/** Hook for managing device / manual location */
export function useDeviceLocation() {
  const [locationState, setLocationState] = useState<LocationState>({
    city: DEFAULT_COORDS.city,
    latitude: DEFAULT_COORDS.latitude,
    longitude: DEFAULT_COORDS.longitude,
    source: "none",
    error: null,
  });
  const [loading, setLoading] = useState(false);

  const requestNativeLocation = useCallback(async () => {
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setLocationState((prev) => ({
          ...prev,
          source: prev.source === "manual" ? "manual" : "none",
          error: "定位权限未开启，可点击上方手动选择城市",
        }));
        setLoading(false);
        return false;
      }

      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const { latitude, longitude } = loc.coords;
      let cityName = "当前位置";

      try {
        const reverse = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (reverse && reverse.length > 0) {
          const first = reverse[0];
          cityName = first.city || first.subregion || first.region || first.district || "当前位置";
        }
      } catch {
        cityName = `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
      }

      const isMock = loc.mocked || false;
      setLocationState({
        city: cityName,
        latitude,
        longitude,
        source: isMock ? "simulated" : "gps",
        error: null,
      });
      setLoading(false);
      return true;
    } catch (err: any) {
      setLocationState((prev) => ({
        ...prev,
        error: err?.message || "获取定位失败，可手动选择城市",
      }));
      setLoading(false);
      return false;
    }
  }, []);

  const setManualCity = useCallback((city: CitySearchItem) => {
    setLocationState({
      city: city.name,
      latitude: city.latitude,
      longitude: city.longitude,
      source: "manual",
      error: null,
    });
  }, []);

  useEffect(() => {
    requestNativeLocation();
  }, [requestNativeLocation]);

  return {
    ...locationState,
    loading,
    requestNativeLocation,
    setManualCity,
  };
}
