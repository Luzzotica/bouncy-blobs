import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function BundleHeader() {
  return (
    <Frame width={707} height={232} background={palette.bg}>
      <HeroImg
        src={GEN.bundleHeader}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // Shift the visible window DOWN in the source so the bottoms
          // of the larger blobs (especially the fully-inflated yellow)
          // aren't clipped against the canvas bottom edge.
          objectPosition: "center 60%",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(90deg, rgba(10,6,18,0.75) 0%, rgba(10,6,18,0.2) 60%, transparent 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 20, top: 10 }}>
        <Logo size={0.75} />
      </div>
    </Frame>
  );
}
