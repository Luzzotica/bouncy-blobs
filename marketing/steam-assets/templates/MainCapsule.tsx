import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function MainCapsule() {
  return (
    <Frame width={616} height={353} background={palette.bg}>
      <HeroImg
        src={GEN.main}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, rgba(10,6,18,0) 0%, rgba(10,6,18,0) 55%, rgba(10,6,18,0.65) 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 22, display: "flex", justifyContent: "center" }}>
        <Logo size={1} />
      </div>
    </Frame>
  );
}
