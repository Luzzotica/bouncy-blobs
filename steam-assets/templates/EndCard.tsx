import React from "react";
import { Frame, Logo, Blob, PaperCard, palette, fonts } from "./_shared";

// 1080×1920 portrait end card appended to match-shorts clips. On-brand
// cream-paper-and-purple-tape "wishlist" call-to-action. Rendered to PNG via
// the steam-assets harness and consumed by scripts/match-shorts/cut.ts.
export function EndCard() {
  return (
    <Frame width={1080} height={1920} background={palette.bg}>
      {/* Soft lavender glow behind the action */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "42%",
          width: 1300,
          height: 1300,
          transform: "translate(-50%, -50%)",
          background: `radial-gradient(circle, rgba(199,125,255,0.22) 0%, rgba(199,125,255,0) 60%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 70,
          padding: 80,
          boxSizing: "border-box",
        }}
      >
        <Logo size={2.0} />

        {/* Blob trio */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 40 }}>
          <div style={{ transform: "rotate(-8deg)" }}><Blob size={150} hue={palette.accentPink} /></div>
          <Blob size={230} hue={palette.blob} />
          <div style={{ transform: "rotate(7deg)" }}><Blob size={150} hue={palette.accentYellow} /></div>
        </div>

        <PaperCard tape={palette.accentYellow} rotate={-2} padding="40px 64px">
          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 900,
              fontSize: 92,
              lineHeight: 1.02,
              textAlign: "center",
              letterSpacing: 1,
            }}
          >
            WISHLIST<br />ON STEAM
          </div>
        </PaperCard>

        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 800,
            fontSize: 40,
            color: palette.accentLavender,
            letterSpacing: 1,
            textAlign: "center",
          }}
        >
          Search “Bouncy Blobs” on Steam
        </div>
      </div>
    </Frame>
  );
}
