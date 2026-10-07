// The controller only needs the theme switch: cave (default) or `?theme=classic`.
export const isCave =
  typeof location === "undefined" || new URLSearchParams(location.search).get("theme") !== "classic";
