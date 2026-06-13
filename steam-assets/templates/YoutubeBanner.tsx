import React from "react";
import { Frame, Logo, Blob, palette, fonts, GEN } from "./_shared";

// 2048×1152 YouTube channel banner. YouTube crops this hard per device — only
// the centered 1235×338 "safe area" is guaranteed visible (TV shows the full
// 2048×1152). So: key content (logo + mascot + tagline) lives in the centered
// safe band; decorative blobs fill the outer wings for wide/TV displays.
const SAFE_W = 1235;
const SAFE_H = 338;

export function YoutubeBanner() {
  return (
    <Frame width={2048} height={1152} background={palette.bg}>
      {/* Vignette + central lavender glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(120% 90% at 50% 50%, rgba(90,24,154,0.45) 0%, rgba(10,6,18,0) 55%), radial-gradient(circle at 50% 48%, rgba(199,125,255,0.30) 0%, rgba(199,125,255,0) 45%)`,
        }}
      />

      {/* Decorative blobs in the wings (outside the mobile-safe band) */}
      <Deco left={150} top={150} size={170} hue={palette.accentPink} rot={-12} />
      <Deco left={360} top={760} size={230} hue={palette.accentYellow} rot={8} />
      <Deco left={1640} top={140} size={210} hue={palette.accentLavender} rot={10} />
      <Deco left={1760} top={720} size={180} hue={palette.blob} rot={-8} />

      {/* Centered safe-area content */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: SAFE_W,
          height: SAFE_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 44,
        }}
      >
        <img
          src={GEN.small}
          alt="Bouncy Blobs mascot"
          style={{
            width: 290,
            height: 290,
            flexShrink: 0,
            objectFit: "contain",
            WebkitMaskImage: "radial-gradient(circle at 50% 48%, #000 58%, transparent 78%)",
            maskImage: "radial-gradient(circle at 50% 48%, #000 58%, transparent 78%)",
            filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.5))",
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 22 }}>
          <Logo size={1.7} />
          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 800,
              fontSize: 40,
              color: palette.paper,
              letterSpacing: 1,
              opacity: 0.95,
            }}
          >
            Bounce · Squish · Conquer
          </div>
          {/* "New clips daily" pill */}
          <div
            style={{
              marginTop: 4,
              background: palette.accentLavender,
              color: palette.ink,
              fontFamily: fonts.display,
              fontWeight: 900,
              fontSize: 30,
              letterSpacing: 2,
              textTransform: "uppercase",
              padding: "12px 26px",
              borderRadius: 999,
              border: `4px solid ${palette.bg}`,
              transform: "rotate(-1.5deg)",
              boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
            }}
          >
            ▶ New clips daily
          </div>
        </div>
      </div>
    </Frame>
  );
}

function Deco({ left, top, size, hue, rot }: { left: number; top: number; size: number; hue: string; rot: number }) {
  return (
    <div style={{ position: "absolute", left, top, transform: `rotate(${rot}deg)`, opacity: 0.85 }}>
      <Blob size={size} hue={hue} />
    </div>
  );
}
