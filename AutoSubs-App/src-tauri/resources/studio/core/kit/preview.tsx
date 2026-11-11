// Ảnh xem trước của một part: mỗi file trong src/parts/ export `preview: Preview`, tool check --part chụp mỗi góc một khung.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export type Preview = { views: number; C: React.FC<{ view: number }> };

/** Composition xem trước: khung k hiện góc k. */
export const PreviewHost: React.FC<{ preview: Preview }> = ({ preview }) => {
  const view = useCurrentFrame() % preview.views;
  return <AbsoluteFill style={{ backgroundColor: '#20232a' }}><preview.C view={view} /></AbsoluteFill>;
};
