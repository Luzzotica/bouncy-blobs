import React from "react";
import { Frame, Logo, PaperCard, palette, fonts, GEN } from "./_shared";

// 1080×1920 portrait end card appended to match-shorts clips. On-brand
// cream-paper-and-purple-tape "wishlist" call-to-action, built around the
// real teal blob mascot (public/refs/generated/small.png). Rendered to PNG
// via the steam-assets harness; consumed by scripts/match-shorts/cut.ts.
export function EndCard() {
  return (
    <Frame width={1080} height={1920} background={palette.bg}>
      {/* Lavender glow behind the mascot */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "44%",
          width: 1400,
          height: 1400,
          transform: "translate(-50%, -50%)",
          background: `radial-gradient(circle, rgba(199,125,255,0.28) 0%, rgba(199,125,255,0) 60%)`,
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
          gap: 56,
          padding: 80,
          boxSizing: "border-box",
        }}
      >
        <Logo size={2.0} />

        {/* Hero mascot. The asset's own dark-purple vignette blends into the
            frame background, so no seam despite being a square source. */}
        <img
          src={GEN.small}
          alt="Bouncy Blobs mascot"
          style={{
            width: 720,
            height: 720,
            objectFit: "contain",
            // Feather the square source edges into the card background so the
            // asset's own vignette doesn't read as a visible box.
            WebkitMaskImage: "radial-gradient(circle at 50% 48%, #000 58%, transparent 78%)",
            maskImage: "radial-gradient(circle at 50% 48%, #000 58%, transparent 78%)",
            filter: "drop-shadow(0 24px 40px rgba(0,0,0,0.45))",
          }}
        />

        <PaperCard tape={palette.accentYellow} rotate={-2} padding="38px 64px">
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
