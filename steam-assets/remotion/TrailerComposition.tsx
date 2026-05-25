import React from "react";
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { palette, game } from "../templates/_shared";

const FPS = 30;
export const TRAILER_DURATION_FRAMES = 30 * FPS; // 30s placeholder

function Title() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20, 70, 90], [0, 1, 1, 0], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at center, ${palette.bgAlt}, ${palette.bg})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
      }}
    >
      <div style={{ textAlign: "center", color: palette.primary, fontFamily: "Inter, system-ui" }}>
        <div style={{ fontSize: 220, fontWeight: 900, letterSpacing: -4 }}>{game.title}</div>
        <div style={{ fontSize: 48, color: palette.ink, marginTop: 20 }}>{game.tagline}</div>
      </div>
    </AbsoluteFill>
  );
}

function Gameplay() {
  return (
    <AbsoluteFill style={{ background: palette.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: palette.inkSoft, fontSize: 40 }}>[ gameplay footage goes here ]</div>
    </AbsoluteFill>
  );
}

export const TrailerComposition: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={90}>
      <Title />
    </Sequence>
    <Sequence from={90} durationInFrames={TRAILER_DURATION_FRAMES - 90}>
      <Gameplay />
    </Sequence>
  </>
);
