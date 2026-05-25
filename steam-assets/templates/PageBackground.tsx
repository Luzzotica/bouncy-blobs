import React from "react";
import { Frame, HeroImg, palette, GEN } from "./_shared";

export function PageBackground() {
  return (
    <Frame width={1438} height={810} background={palette.bg}>
      <HeroImg
        src={GEN.pageBackground}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(6px) saturate(1.1)",
          transform: "scale(1.06)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at center, transparent 0%, ${palette.bg} 90%)`,
        }}
      />
    </Frame>
  );
}
