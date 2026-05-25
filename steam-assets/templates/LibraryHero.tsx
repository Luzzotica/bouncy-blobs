import React from "react";
import { Frame, HeroImg, palette, GEN } from "./_shared";

// REMINDER: NO text, NO logo — Steam overlays its own UI on top.
export function LibraryHero() {
  return (
    <Frame width={3840} height={1240} background={palette.bg}>
      <HeroImg
        src={GEN.libraryHero}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at center, transparent 30%, rgba(10,6,18,0.55) 100%)`,
        }}
      />
    </Frame>
  );
}
