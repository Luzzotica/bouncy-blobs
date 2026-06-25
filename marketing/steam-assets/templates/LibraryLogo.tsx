import React from "react";
import { Logo } from "./_shared";

// Transparent PNG — rendered with omitBackground=true.
// Steam scales this down — render generous, the logo sits in the middle 60%.
export function LibraryLogo() {
  return (
    <div
      style={{
        width: 1280,
        height: 720,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
      }}
    >
      <Logo size={2.2} />
    </div>
  );
}
