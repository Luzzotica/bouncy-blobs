import React from "react";
import { HeroImg, GEN } from "./_shared";

export function CommunityIcon() {
  return (
    <HeroImg
      src={GEN.small}
      style={{
        width: 184,
        height: 184,
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}
