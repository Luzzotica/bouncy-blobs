import React from "react";
import { Composition } from "remotion";
import { TrailerComposition, TRAILER_DURATION_FRAMES } from "./TrailerComposition";

export const Root: React.FC = () => (
  <>
    <Composition
      id="Trailer"
      component={TrailerComposition}
      durationInFrames={TRAILER_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
