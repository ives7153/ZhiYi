import React from 'react';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * Inline reproduction of `frontend/public/logo.svg` using react-native-svg.
 *
 * The Web asset is a 100x100 rounded square with a dark gradient and a white
 * braille "W" (dots 2,4,5,6). Drawn as vectors rather than a bitmap so it stays
 * crisp at any size and matches the Web rendering exactly.
 *
 * The drop-shadow filter of the original is omitted deliberately: SVG filters
 * are not supported by react-native-svg, and approximating it would change the
 * artwork.
 */
export function Logo({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="boxGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#2a2a2a" />
          <Stop offset="100%" stopColor="#1a1a1a" />
        </LinearGradient>
      </Defs>

      {/* 3D box background */}
      <Rect x="8" y="8" width="84" height="84" rx="16" fill="url(#boxGradient)" />

      {/* Subtle inner highlight */}
      <Rect x="10" y="10" width="80" height="40" rx="14" fill="#ffffff" opacity="0.05" />

      {/* Braille W: dots 2,4,5,6 */}
      <Circle cx="35" cy="50" r="9" fill="#fafafa" />
      <Circle cx="65" cy="28" r="9" fill="#fafafa" />
      <Circle cx="65" cy="50" r="9" fill="#fafafa" />
      <Circle cx="65" cy="72" r="9" fill="#fafafa" />
    </Svg>
  );
}
