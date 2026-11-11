// Ráp video từ plan/timeline.json. .build/Video.tsx (sinh bởi core/tools/build.py) đưa vào spec: danh sách cảnh theo thứ tự,
// mỗi cảnh một loại (code / clip / still) và cú chuyển VÀO cảnh. Âm thanh lấy từ .build/public: voice.mp3, music.wav, sfx.wav
// (core/tools/audio.py trộn sẵn theo plan/mix.json và sfx của các chương).
// Chuyển cảnh chồng T khung: cảnh hai bên mỗi bên kéo dài T/2 nên mốc voice không trôi. Cảnh nhận giây bắt đầu qua SceneStart.
import React from 'react';
import { AbsoluteFill, staticFile } from 'remotion';
import { Audio } from '@remotion/media';
import { TransitionSeries, linearTiming, type TransitionPresentation } from '@remotion/transitions';
import { z } from 'zod';
import { SceneStart } from './time';
import { ClipScene, StillScene, type Move } from './scenes';

// Bật/tắt nhạc nền và tiếng động từ bảng Props của Studio hoặc cờ --no-music / --no-sfx của render.py.
export const propsSchema = z.object({ music: z.boolean(), sfx: z.boolean() });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Transition = TransitionPresentation<any> | null;

export type SceneSpec = {
  id: string;
  from: number;
  to: number;
  type: 'code' | 'clip' | 'still';
  /** Cảnh code, hoặc lớp vẽ đè lên clip / still ("overlay": true). */
  C?: React.FC;
  asset?: string;
  in?: number;
  move?: Move;
  volume?: number;
  /** Cú chuyển vào cảnh này; null = cắt thẳng. */
  transition?: Transition;
};

/** music / sfx: mức nhạc nền và tiếng động so với voice (plan/mix.json → volume). */
export type VideoSpec = { fps: number; scenes: SceneSpec[]; overlays: React.FC[]; music?: number; sfx?: number };

const T = 12;

export const durationOf = (v: VideoSpec) => Math.round(v.scenes[v.scenes.length - 1].to * v.fps);

const SceneBody: React.FC<{ s: SceneSpec; lead: number }> = ({ s, lead }) => (
  <AbsoluteFill style={{ backgroundColor: '#000' }}>
    {s.type === 'clip' && s.asset && <ClipScene id={s.asset} start={Math.max(0, (s.in ?? 0) - lead)} volume={s.volume} />}
    {s.type === 'still' && s.asset && <StillScene id={s.asset} move={s.move} />}
    {s.C && <s.C />}
  </AbsoluteFill>
);

/** Một cảnh đứng riêng (check --scene): t0 = giây voice ở khung 0 của composition. */
export const SceneView: React.FC<{ s: SceneSpec; t0: number }> = ({ s, t0 }) => (
  <SceneStart.Provider value={t0}>
    <SceneBody s={s} lead={Math.max(0, s.from - t0)} />
  </SceneStart.Provider>
);

export const VideoTimeline: React.FC<{ spec: VideoSpec; music?: boolean; sfx?: boolean }> = ({ spec, music = true, sfx = true }) => {
  const { fps, scenes } = spec;
  const at = scenes.map((s) => Math.round(s.from * fps)).concat(Math.round(scenes[scenes.length - 1].to * fps));
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <TransitionSeries>
        {scenes.map((s, k) => {
          const before = k > 0 && scenes[k].transition ? T / 2 : 0;
          const after = k < scenes.length - 1 && scenes[k + 1].transition ? T / 2 : 0;
          return (
            <React.Fragment key={s.id}>
              {before > 0 && <TransitionSeries.Transition presentation={s.transition!} timing={linearTiming({ durationInFrames: T })} />}
              <TransitionSeries.Sequence durationInFrames={at[k + 1] - at[k] + before + after} name={s.id}>
                <SceneStart.Provider value={(at[k] - before) / fps}>
                  <SceneBody s={s} lead={before / fps} />
                </SceneStart.Provider>
              </TransitionSeries.Sequence>
            </React.Fragment>
          );
        })}
      </TransitionSeries>
      {spec.overlays.map((O, i) => <AbsoluteFill key={i}><O /></AbsoluteFill>)}
      <Audio src={staticFile('voice.mp3')} />
      {music && spec.music !== 0 && <Audio src={staticFile('music.wav')} volume={spec.music ?? 0.4} />}
      {sfx && spec.sfx !== 0 && <Audio src={staticFile('sfx.wav')} volume={spec.sfx ?? 0.5} />}
    </AbsoluteFill>
  );
};

/** Khung giữ chỗ cho cảnh chưa dựng hoặc đang lỗi (build tự thay vào). */
export const placeholder = (name: string, note: string): React.FC => {
  const P: React.FC = () => (
    <AbsoluteFill style={{ background: '#2a2f3a', color: '#ffd166', fontFamily: 'monospace', fontSize: 64, alignItems: 'center', justifyContent: 'center', gap: 24, textAlign: 'center' }}>
      <div>{name}</div>
      <div style={{ fontSize: 30, color: '#c9d1e0', maxWidth: '80%' }}>{note}</div>
    </AbsoluteFill>
  );
  P.displayName = `Placeholder_${name}`;
  return P;
};
