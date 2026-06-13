import React from "react";

// SINGLE SOURCE OF TRUTH — Bouncy Blobs visual identity.
// Mirrors `.claude/skills/bouncy-blobs-style/SKILL.md` and the main-menu
// title treatment in `src/pages/Home.tsx`. If you edit a value here, mirror
// it in the other two places in the same commit.

export const palette = {
  bg: "#0a0612",            // deep purple-black
  bgAlt: "#1a0f2e",         // deep purple panel
  paper: "#fffae6",         // cream sticky-note surface
  ink: "#1a0f2e",           // text on paper
  titleInk: "#fffae6",      // big-title text color
  titleShadow: "#c77dff",   // lavender chunky drop
  titleOutline: "#0a0612",  // outline = bg

  accentPurple: "#5a189a",
  accentLavender: "#c77dff",
  accentPink: "#e85d75",
  accentGreen: "#2d6a4f",
  accentYellow: "#fdd835",

  // Canonical marketing teal — matches the blob in public/intro/p3d.png
  // and the language ("teal-green BLOB GOOP") used across the
  // generate_*.py scripts. The in-game player-customization palette
  // (`src/utils/customization.ts`) ALSO contains a green entry — that's
  // a player choice, not marketing canon.
  blob: "#4ac8c8",
  blobDeep: "#2d8a8a",
  blobGoo: "#7be3e3",
};

export const fonts = {
  display: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
  body: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
};

export const game = {
  title: "Bouncy Blobs",
  tagline: "Bounce, squish, conquer.",
};

// Reg character sheets — served from bouncy-blobs/public/refs/reg/
export const REG = {
  front: "/refs/reg/reg_front.png",
  side: "/refs/reg/reg_side.png",
  threeQuarter: "/refs/reg/reg_three_quarter.png",
  threeQuarterStage1: "/refs/reg/reg_three_quarter_stage1.png",
  threeQuarterStage2: "/refs/reg/reg_three_quarter_stage2.png",
};

// Lab-scene splash with Reg + blob pile — already in public/menu/.
// Used as fallback / page-background blur. Per-asset art is in GEN below.
export const HERO_IMG = "/menu/menu_hero.png";

// Generated per-asset art lives at public/refs/generated/<name>.png.
// Run `pnpm gen:art <name|all>` to produce these (Gemini or OpenAI).
export const GEN = {
  header: "/refs/generated/header.png",
  small: "/refs/generated/small.png",
  main: "/refs/generated/main.png",
  vertical: "/refs/generated/vertical.png",
  libraryCapsule: "/refs/generated/library-capsule.png",
  libraryHero: "/refs/generated/library-hero.png",
  libraryHeader: "/refs/generated/library-header.png",
  pageBackground: "/refs/generated/page-background.png",
  bundleHeader: "/refs/generated/bundle-header.png",
  workshopBranding: "/refs/generated/workshop-branding.png",
};

// If a generated file is missing, the renderer falls back to HERO_IMG.
// Use this in templates instead of bare GEN.x so first-run still produces something.
export function genOrHero(generated: string): string {
  return generated; // Vite returns 404 if missing; <img onError> below swaps to HERO_IMG.
}

export function HeroImg({ src, ...rest }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  return (
    <img
      src={src}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError={(e) => {
        const t = e.currentTarget as HTMLImageElement;
        if (t.src.indexOf(HERO_IMG) === -1) t.src = HERO_IMG;
      }}
      {...rest}
    />
  );
}

export function Frame({
  width,
  height,
  children,
  background = palette.bg,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
  background?: string;
}) {
  return (
    <div
      style={{
        width,
        height,
        background,
        color: palette.titleInk,
        fontFamily: fonts.display,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

// Sub-wordmark for Workshop / sub-brands (e.g. "The Blob Forge").
// Smaller, tighter than the main Logo, but uses the same lavender drop +
// dark outline treatment so it reads as part of the same family.
export function SubLogo({ text, size = 1 }: { text: string; size?: number }) {
  const off = Math.max(2, Math.round(3 * size));
  const out = Math.max(1, Math.round(1.5 * size));
  return (
    <div
      style={{
        fontFamily: fonts.display,
        fontWeight: 900,
        fontSize: 32 * size,
        letterSpacing: 2,
        lineHeight: 1,
        color: palette.paper,
        textShadow: [
          `${off}px ${off}px 0 ${palette.titleShadow}`,
          `-${out}px -${out}px 0 ${palette.titleOutline}`,
          `${out}px -${out}px 0 ${palette.titleOutline}`,
          `-${out}px ${out}px 0 ${palette.titleOutline}`,
          `${out}px ${out}px 0 ${palette.titleOutline}`,
        ].join(", "),
        textTransform: "uppercase",
        transform: "rotate(-1deg)",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      {text}
    </div>
  );
}

// Canonical Bouncy Blobs wordmark — matches src/pages/Home.tsx title.
export function Logo({ size = 1 }: { size?: number }) {
  const off = Math.max(3, Math.round(5 * size));
  const out = Math.max(2, Math.round(2 * size));
  return (
    <div
      style={{
        fontFamily: fonts.display,
        fontWeight: 900,
        fontSize: 64 * size,
        letterSpacing: 1,
        lineHeight: 1,
        color: palette.titleInk,
        textShadow: [
          `${off}px ${off}px 0 ${palette.titleShadow}`,
          `-${out}px -${out}px 0 ${palette.titleOutline}`,
          `${out}px -${out}px 0 ${palette.titleOutline}`,
          `-${out}px ${out}px 0 ${palette.titleOutline}`,
          `${out}px ${out}px 0 ${palette.titleOutline}`,
        ].join(", "),
        transform: "rotate(-2deg)",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      {game.title}
    </div>
  );
}

// Sticky-note paper card. Use this for any panel/button on a render.
export function PaperCard({
  children,
  tape = palette.accentLavender,
  rotate = -1,
  padding = "20px 32px",
}: {
  children: React.ReactNode;
  tape?: string;
  rotate?: number;
  padding?: string | number;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        background: palette.paper,
        color: palette.ink,
        border: `4px solid ${palette.bg}`,
        borderRadius: 4,
        padding,
        fontWeight: 800,
        letterSpacing: 0.5,
        textShadow: "1px 1px 0 rgba(199,125,255,0.4)",
        boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
        transform: `rotate(${rotate}deg)`,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: -10,
          left: "50%",
          transform: "translateX(-50%) rotate(-3deg)",
          width: "60%",
          height: 16,
          background: tape,
          border: "1px solid rgba(0,0,0,0.25)",
          opacity: 0.85,
          boxShadow: "0 2px 3px rgba(0,0,0,0.2)",
          pointerEvents: "none",
        }}
      />
      {children}
    </div>
  );
}

// NOTE: the CSS-drawn `Blob` (gradient circle + googly eyes) was removed —
// it looked cheap ("robot faces"). Use the real generated character art
// (public/refs/generated/*.png via scripts/generate_steam_assets.py) instead.
