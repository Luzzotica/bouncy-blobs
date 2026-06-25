import React from "react";
import { HeroImg, GEN } from "./_shared";

export function ClientIcon() {
  return (
    <HeroImg
      src={GEN.small}
      style={{
        width: 256,
        height: 256,
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}
