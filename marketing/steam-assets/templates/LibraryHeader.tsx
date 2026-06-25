import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function LibraryHeader() {
  return (
    <Frame width={460} height={215} background={palette.bg}>
      <HeroImg
        src={GEN.libraryHeader}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(90deg, rgba(10,6,18,0.7) 0%, rgba(10,6,18,0.15) 55%, transparent 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 18, top: 22 }}>
        <Logo size={0.6} />
      </div>
    </Frame>
  );
}
