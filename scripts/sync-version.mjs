#!/usr/bin/env node
// Sync the app version from package.json into the committed iOS project
// files. Android needs no sync (build.gradle.kts reads tauri.properties,
// which the Tauri CLI writes from tauri.conf.json — and tauri.conf.json's
// "version" points at package.json). The iOS project.yml / Info.plist are
// committed with literal versions, so they drift unless this runs.
//
// Run after bumping package.json (the bump-version flow), or standalone:
//   node scripts/sync-version.mjs
//
// Optional build number (CFBundleVersion), independent of marketing version:
//   IOS_BUILD=2.0.0.2 node scripts/sync-version.mjs
//   node scripts/sync-version.mjs --build 2.0.0.2
// Defaults CFBundleVersion to the marketing version when unset.
// Apple requires each upload's CFBundleVersion to be strictly greater than
// all previous uploads (missing components count as zero — so "2" == "2.0.0").

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: package.json version "${version}" is not semver`);
  process.exit(1);
}

/** Parse --build <n> or IOS_BUILD / package.json iosBuildNumber. */
function resolveBuildNumber() {
  const argv = process.argv.slice(2);
  const flagIdx = argv.findIndex((a) => a === '--build' || a === '-b');
  if (flagIdx >= 0 && argv[flagIdx + 1]) return String(argv[flagIdx + 1]);
  if (process.env.IOS_BUILD) return String(process.env.IOS_BUILD);
  if (pkg.iosBuildNumber != null) return String(pkg.iosBuildNumber);
  return version;
}

const build = resolveBuildNumber();
if (!/^\d+(\.\d+)*$/.test(build)) {
  console.error(`sync-version: build number "${build}" must be dotted integers`);
  process.exit(1);
}

const targets = [
  {
    path: 'src-tauri/gen/apple/project.yml',
    edits: [
      [/CFBundleShortVersionString: .*/g, `CFBundleShortVersionString: ${version}`],
      [/CFBundleVersion: .*/g, `CFBundleVersion: "${build}"`],
    ],
  },
  {
    path: 'src-tauri/gen/apple/app_iOS/Info.plist',
    edits: [
      [
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${version}$2`,
      ],
      [/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${build}$2`],
    ],
  },
];

for (const t of targets) {
  const file = join(root, t.path);
  let text = readFileSync(file, 'utf8');
  const before = text;
  for (const [re, replacement] of t.edits) text = text.replace(re, replacement);
  if (text !== before) {
    writeFileSync(file, text);
    console.log(`→ ${t.path}: marketing ${version}, build ${build}`);
  } else {
    console.log(`  ${t.path} already marketing ${version}, build ${build}`);
  }
}
