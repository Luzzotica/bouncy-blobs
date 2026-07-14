#!/usr/bin/env node
// Sync the app version from package.json into the committed iOS project
// files. Android needs no sync (build.gradle.kts reads tauri.properties,
// which the Tauri CLI writes from tauri.conf.json — and tauri.conf.json's
// "version" points at package.json). The iOS project.yml / Info.plist are
// committed with literal versions, so they drift unless this runs.
//
// Run after bumping package.json (the bump-version flow), or standalone:
//   node scripts/sync-version.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-version: package.json version "${version}" is not semver`);
  process.exit(1);
}

const targets = [
  {
    path: 'src-tauri/gen/apple/project.yml',
    edits: [
      [/CFBundleShortVersionString: .*/g, `CFBundleShortVersionString: ${version}`],
      [/CFBundleVersion: .*/g, `CFBundleVersion: "${version}"`],
    ],
  },
  {
    path: 'src-tauri/gen/apple/app_iOS/Info.plist',
    edits: [
      [
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${version}$2`,
      ],
      [/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${version}$2`],
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
    console.log(`→ ${t.path} = ${version}`);
  } else {
    console.log(`  ${t.path} already ${version}`);
  }
}
