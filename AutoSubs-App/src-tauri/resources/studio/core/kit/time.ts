// Thời gian và nội suy dùng chung. Mọi mốc trong cảnh viết theo giây voice tuyệt đối (useT), không theo khung cục bộ.
import { createContext, useContext } from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/** Giây voice tuyệt đối ở khung 0 của cảnh đang dựng; timeline đặt giá trị này cho từng cảnh. */
export const SceneStart = createContext(0);

/** Giây voice tuyệt đối của khung hiện tại. */
export const useT = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return useContext(SceneStart) + frame / fps;
};

/** Lò xo theo giây tuyệt đối: 0 trước `at`, tới 1 có vượt đích. */
export const useSpring = (t: number, at: number, damping = 10, stiffness = 160) => {
  const { fps } = useVideoConfig();
  return spring({ frame: Math.round((t - at) * fps), fps, config: { damping, stiffness } });
};

/** Tiến độ 0..1 giữa a và b (giây), có easing. */
export const prog = (t: number, a: number, b: number, ease: (x: number) => number = Easing.bezier(0.45, 0, 0.2, 1)) =>
  interpolate(t, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
/** Nhô lên rồi xuống trong d giây từ a (0 ngoài khoảng). */
export const bump = (t: number, a: number, d: number) => { const p = (t - a) / d; return p <= 0 || p >= 1 ? 0 : Math.sin(p * Math.PI); };
/** Số ngẫu nhiên tất định 0..1 theo hạt giống. */
export const rnd = (s: number) => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
/** Radian → độ: dùng cho SVG rotate. */
export const deg = (r: number) => (r * 180) / Math.PI;

/** Pha hai màu hex. */
export function mix(a: string, b: string, p = 0.5): string {
  const q = Math.max(0, Math.min(1, p));
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(lerp((ah >> s) & 255, (bh >> s) & 255, q));
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}
