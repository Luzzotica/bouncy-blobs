import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

// Steam Workshop branding banner (948×203). Steam overlays a title +
// short sentence on the RIGHT side — keep all our artwork + wordmarks
// on the LEFT ~55%, leave the right side visually quiet.
export function WorkshopBranding() {
  return (
    <Frame width={948} height={203} background={palette.bg}>
      <HeroImg
        src={GEN.workshopBranding}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
      {/* Gradient: dark-left fade for wordmark contrast, very dark right
          half so Steam's overlay text reads cleanly on it. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, " +
            "rgba(10,6,18,0.55) 0%, " +
            "rgba(10,6,18,0.25) 35%, " +
            "rgba(10,6,18,0.55) 55%, " +
            "rgba(10,6,18,0.92) 100%)",
        }}
      />
      <div style={{ position: "absolute", left: 20, top: 16 }}>
        <Logo size={0.7} />
      </div>
    </Frame>
  );
}
