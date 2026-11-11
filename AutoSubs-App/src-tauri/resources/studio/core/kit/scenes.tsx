// Cảnh dựng sẵn cho type "clip" (footage cắt từ giây in) và "still" (ảnh có chuyển động máy). Không cần code riêng.
import React from 'react';
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Video } from '@remotion/media';
import { asset } from './asset';

export type Move = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'none';

/** Footage `id` bắt đầu từ giây `start` của file, phủ kín khung. Tiếng gốc tắt trừ khi có volume. */
export const ClipScene: React.FC<{ id: string; start: number; volume?: number }> = ({ id, start, volume }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Video src={asset(id)} trimBefore={Math.max(0, Math.round(start * fps))} muted={!volume} volume={volume ?? 0}
        objectFit="cover" style={{ width: '100%', height: '100%' }} />
    </AbsoluteFill>
  );
};

const MOVES: Record<Move, [number, number, number, number]> = {
  // scale đầu, scale cuối, dịch x đầu, dịch x cuối (% khung)
  'zoom-in': [1.0, 1.12, 0, 0],
  'zoom-out': [1.12, 1.0, 0, 0],
  'pan-left': [1.1, 1.1, 3, -3],
  'pan-right': [1.1, 1.1, -3, 3],
  none: [1, 1, 0, 0],
};

/** Ảnh `id` phủ kín khung, chuyển động `move` đều suốt cảnh. */
export const StillScene: React.FC<{ id: string; move?: Move }> = ({ id, move = 'zoom-in' }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const [s0, s1, x0, x1] = MOVES[move] ?? MOVES['zoom-in'];
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      <Img src={asset(id)} style={{ width: '100%', height: '100%', objectFit: 'cover',
        transform: `translateX(${x0 + (x1 - x0) * p}%) scale(${s0 + (s1 - s0) * p})` }} />
    </AbsoluteFill>
  );
};
