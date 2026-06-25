/* Assembles Steam copy from copy/*.md, enforces character limits,
 * and prints final "About This Game" BBCode to stdout. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const COPY = resolve(process.cwd(), "copy");

const LIMITS: Record<string, number> = {
  "name.md": 40,
  "short-description.md": 300,
  "elevator.md": 240,
};

function read(file: string): string {
  const raw = readFileSync(resolve(COPY, file), "utf8");
  return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function check(file: string, body: string) {
  const limit = LIMITS[file];
  const len = body.length;
  const tag = limit ? (len > limit ? `❌ ${len}/${limit}` : `✓ ${len}/${limit}`) : `· ${len} chars`;
  console.error(`  ${tag.padEnd(14)} ${file}`);
  if (limit && len > limit) process.exitCode = 1;
}

function main() {
  const files = readdirSync(COPY).filter((f) => f.endsWith(".md")).sort();
  console.error("Copy fields:");
  const bodies: Record<string, string> = {};
  for (const f of files) {
    bodies[f] = read(f);
    check(f, bodies[f]);
  }

  const features = bodies["features.md"]
    ?.split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean) ?? [];

  const bbcode = [
    bodies["elevator.md"] ?? "",
    "",
    "[h1]Features[/h1]",
    "[list]",
    ...features.map((f) => `[*] ${f}`),
    "[/list]",
    "",
    bodies["about.md"] ?? "",
  ].join("\n");

  console.error("\n--- About This Game (BBCode) ---");
  process.stdout.write(bbcode + "\n");
}

main();
