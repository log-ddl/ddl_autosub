// Khung hình: kích thước lấy từ project.json (ngang, dọc, vuông đều đúng), vùng an toàn, lớp SVG phủ toàn khung, rung máy.
import React from 'react';
import { useVideoConfig } from 'remotion';
import { noise2D } from '@remotion/noise';

/** Kích thước khung của video và lề an toàn (5% cạnh ngắn). */
export const useSize = () => {
  const { width: W, height: H } = useVideoConfig();
  return { W, H, SAFE: Math.round(Math.min(W, H) * 0.05) };
};

/** Lớp SVG phủ toàn khung, toạ độ theo pixel của video. */
export const Layer: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => {
  const { W, H } = useSize();
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, overflow: 'visible', ...style }}>{children}</svg>;
};

/** Rung máy quay cầm tay (px) theo giây t. */
export const handheld = (t: number, amp = 3, seed = 'cam') => [noise2D(seed, t * 0.6, 0) * amp, noise2D(seed, 0, t * 0.6) * amp] as const;
