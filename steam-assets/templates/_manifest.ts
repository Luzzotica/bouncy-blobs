import type { ComponentType } from "react";
import { HeaderCapsule } from "./HeaderCapsule";
import { SmallCapsule } from "./SmallCapsule";
import { MainCapsule } from "./MainCapsule";
import { VerticalCapsule } from "./VerticalCapsule";
import { PageBackground } from "./PageBackground";
import { LibraryCapsule } from "./LibraryCapsule";
import { LibraryHero } from "./LibraryHero";
import { LibraryLogo } from "./LibraryLogo";
import { LibraryHeader } from "./LibraryHeader";
import { CommunityIcon } from "./CommunityIcon";
import { ClientIcon } from "./ClientIcon";
import { BundleHeader } from "./BundleHeader";
import { WorkshopBranding } from "./WorkshopBranding";

export interface AssetSpec {
  component: ComponentType;
  width: number;
  height: number;
  // omitBackground=true produces a transparent PNG (used by LibraryLogo)
  transparent?: boolean;
  // Render scale. Steam upscales capsules on high-DPI displays — supplying
  // 2× pixels prevents blurry wordmarks. The React template stays sized at
  // (width, height); the renderer captures at deviceScaleFactor=scale so
  // the resulting PNG is (width*scale × height*scale).
  scale?: number;
}

export const ASSETS: Record<string, AssetSpec> = {
  // 2× scale — these slots are most visible on high-DPI displays.
  header: { component: HeaderCapsule, width: 460, height: 215, scale: 2 },
  small: { component: SmallCapsule, width: 231, height: 87, scale: 2 },
  main: { component: MainCapsule, width: 616, height: 353, scale: 2 },
  vertical: { component: VerticalCapsule, width: 374, height: 448, scale: 2 },
  "library-header": { component: LibraryHeader, width: 460, height: 215, scale: 2 },

  // 1× — already large enough (library hero/capsule/background) or pixel-perfect by spec (icons, logo).
  background: { component: PageBackground, width: 1438, height: 810 },
  "library-capsule": { component: LibraryCapsule, width: 600, height: 900 },
  "library-hero": { component: LibraryHero, width: 3840, height: 1240 },
  "library-logo": { component: LibraryLogo, width: 1280, height: 720, transparent: true },
  "community-icon": { component: CommunityIcon, width: 184, height: 184 },
  "client-icon": { component: ClientIcon, width: 256, height: 256 },
  "bundle-header": { component: BundleHeader, width: 707, height: 232 },

  // Optional: only relevant if the game uses Steam Workshop.
  "workshop-branding": { component: WorkshopBranding, width: 948, height: 203, scale: 2 },
};
