import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

// The background is left transparent so the render can sit over footage
// (render_motion exports ProRes 4444 with alpha). For a full-frame card,
// give the outer AbsoluteFill a backgroundColor.
export const Scene = ({ title, subtitle }: { title: string; subtitle: string }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [durationInFrames - 15, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: exit }}>
      <div
        style={{
          fontFamily: "Inter, Helvetica, Arial, sans-serif",
          fontSize: 120,
          fontWeight: 800,
          color: "white",
          textShadow: "0 6px 30px rgba(0,0,0,0.5)",
          transform: `translateY(${(1 - enter) * 60}px)`,
          opacity: enter,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 24,
          fontFamily: "Inter, Helvetica, Arial, sans-serif",
          fontSize: 48,
          color: "rgba(255,255,255,0.85)",
          opacity: interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};
