import React from "react";
import { Frame, HeroImg, palette, game, fonts, GEN } from "./_shared";

// At 231×87 the full wordmark is unreadable — use a single-line, tight version
// with the canonical lavender drop-shadow but smaller offsets.
export function SmallCapsule() {
  return (
    <Frame width={231} height={87} background={palette.bg}>
      <HeroImg
        src={GEN.small}
        style={{
          position: "absolute",
          left: 2,
          top: 4,
          bottom: 4,
          width: 72,
          height: 72,
          objectFit: "cover",
          borderRadius: 8,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 78,
          right: 4,
          top: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 900,
            fontSize: 20,
            lineHeight: 1,
            color: palette.titleInk,
            textShadow: [
              `2px 2px 0 ${palette.titleShadow}`,
              `-1px -1px 0 ${palette.titleOutline}`,
              `1px -1px 0 ${palette.titleOutline}`,
              `-1px 1px 0 ${palette.titleOutline}`,
              `1px 1px 0 ${palette.titleOutline}`,
            ].join(", "),
            transform: "rotate(-2deg)",
            whiteSpace: "nowrap",
          }}
        >
          {game.title}
        </div>
      </div>
    </Frame>
  );
}
