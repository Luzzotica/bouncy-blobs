import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function LibraryCapsule() {
  return (
    <Frame width={600} height={900} background={palette.bg}>
      <HeroImg
        src={GEN.libraryCapsule}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, rgba(10,6,18,0) 0%, rgba(10,6,18,0) 65%, rgba(10,6,18,0.85) 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center" }}>
        <Logo size={1.15} />
      </div>
    </Frame>
  );
}
