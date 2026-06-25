import React from "react";
import { Frame, Logo, palette, fonts } from "./_shared";

// Social profile banners — LinkedIn (1584×396) and X/Twitter (1500×500).
// Both platforms park the round profile avatar in the LOWER-LEFT corner and,
// on X, lay the @handle/name over the lower band. So the lockup is biased to
// the RIGHT half (which also echoes the user's previous "text on the right"
// banner). A left→right scrim darkens the text side for legibility while the
// edge blobs on the right stay vivid.
//
// Background is the header key-art — six expressive blobs spread across the lab
// floor (sunglasses-blue, teal hero, red, yellow, pink, purple). Cropped low so
// the colorful blob row fills the frame and the bright top-right lamp drops out.
const BG = "/refs/generated/header.png";

function SocialBanner({
  width,
  height,
  logoSize,
  taglineSize,
  rightPad,
  objectPosition,
  transform,
}: {
  width: number;
  height: number;
  logoSize: number;
  taglineSize: number;
  rightPad: number;
  // Per-banner framing. Slight zoom creates horizontal slack so we can pan;
  // translate nudges the focal teal blob LEFT (away from the right-side text)
  // and vertically into place. Each banner's aspect ratio differs, so they
  // need their own values.
  objectPosition: string;
  transform: string;
}) {
  return (
    <Frame width={width} height={height} background={palette.bg}>
      <img
        src={BG}
        alt=""
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition,
          transform,
          transformOrigin: "center",
        }}
      />

      {/* Gentle, even darkening so blobs stay visible across the WHOLE banner,
          plus a soft glow concentrated behind the right-side lockup so the
          wordmark still reads without hiding the art. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(10,6,18,0.12) 0%, rgba(10,6,18,0.2) 55%, rgba(10,6,18,0.32) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 42% 88% at 80% 50%, rgba(10,6,18,0.66) 0%, rgba(10,6,18,0.3) 55%, rgba(10,6,18,0) 78%)",
        }}
      />

      {/* Lockup — vertically centered, right-aligned, clear of the lower-left
          avatar. */}
      <div
        style={{
          position: "absolute",
          right: rightPad,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          textAlign: "right",
          gap: Math.round(height * 0.05),
        }}
      >
        <Logo size={logoSize} />
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 800,
            fontSize: taglineSize,
            color: palette.paper,
            letterSpacing: 1.5,
            textShadow: "0 2px 8px rgba(0,0,0,0.7)",
          }}
        >
          Bounce · Squish · Conquer
        </div>
        <div
          style={{
            marginTop: Math.round(height * 0.01),
            background: palette.accentLavender,
            color: palette.ink,
            fontFamily: fonts.display,
            fontWeight: 900,
            fontSize: Math.round(taglineSize * 0.78),
            letterSpacing: 2,
            textTransform: "uppercase",
            padding: `${Math.round(taglineSize * 0.34)}px ${Math.round(taglineSize * 0.72)}px`,
            borderRadius: 999,
            border: `3px solid ${palette.bg}`,
            transform: "rotate(-1.5deg)",
            boxShadow: "0 6px 16px rgba(0,0,0,0.45)",
          }}
        >
          ▶ Wishlist on Steam
        </div>
      </div>
    </Frame>
  );
}

// 1584×396 LinkedIn personal-profile background.
// Shorter frame: pan further DOWN so the teal blob sits vertically centered
// (not clipped at the top), and further LEFT to clear the wordmark.
export function LinkedInBanner() {
  return (
    <SocialBanner
      width={1584}
      height={396}
      logoSize={1.35}
      taglineSize={28}
      rightPad={72}
      objectPosition="center 50%"
      transform="scale(1.16) translate(-11%, 4%)"
    />
  );
}

// 1500×500 X / Twitter profile header.
export function XBanner() {
  return (
    <SocialBanner
      width={1500}
      height={500}
      logoSize={1.5}
      taglineSize={30}
      rightPad={72}
      objectPosition="center 62%"
      transform="scale(1.16) translate(-14%, 4%)"
    />
  );
}
