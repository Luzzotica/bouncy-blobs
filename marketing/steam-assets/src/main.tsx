import React from "react";
import { createRoot } from "react-dom/client";
import { ASSETS } from "../templates/_manifest";

const params = new URLSearchParams(window.location.search);
const name = params.get("asset") ?? "header";

const entry = ASSETS[name];
if (!entry) {
  document.getElementById("root")!.innerText =
    `Unknown asset "${name}". Known: ${Object.keys(ASSETS).join(", ")}`;
} else {
  const Component = entry.component;
  createRoot(document.getElementById("root")!).render(<Component />);
}
