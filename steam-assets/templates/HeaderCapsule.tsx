import React from "react";
import { Frame, Logo, HeroImg, palette, GEN } from "./_shared";

export function HeaderCapsule() {
  return (
    <Frame width={460} height={215} background={palette.bg}>
      <HeroImg
        src={GEN.header}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // Shift visible window down in the source so blob bodies stay
          // fully visible instead of being clipped at the canvas bottom.
          objectPosition: "center 65%",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(90deg, rgba(10,6,18,0.78) 0%, rgba(10,6,18,0.25) 55%, transparent 100%)`,
        }}
      />
      <div style={{ position: "absolute", left: 18, top: 17 }}>
        <Logo size={0.6} />
      </div>
    </Frame>
  );
}
