import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function VerticalCapsule() {
  return (
    <Frame width={374} height={448} background={palette.bg}>
      <HeroImg
        src={GEN.vertical}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          // Square source covers the portrait canvas with ~10% side crop;
          // prompt is composed for that, so nothing critical is lost.
          objectFit: "cover",
          objectPosition: "center",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(180deg, rgba(10,6,18,0) 0%, rgba(10,6,18,0) 78%, rgba(10,6,18,0.8) 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, display: "flex", justifyContent: "center" }}>
        <Logo size={0.6} />
      </div>
    </Frame>
  );
}
