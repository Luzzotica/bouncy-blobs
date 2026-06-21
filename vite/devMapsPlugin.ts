import fs from 'node:fs';
import path from 'node:path';

/**
 * Dev-only Vite middleware that lets the in-app level editor read and write the
 * repo's shipped maps under `public/levels/`. It exists ONLY while the dev
 * server runs (`apply: 'serve'`), so none of this ships in a production build —
 * the browser can't otherwise write to the repo filesystem.
 *
 * Endpoints (all under /__dev/levels):
 *   GET  /__dev/levels/manifest        → current manifest.json
 *   POST /__dev/levels/save            → { id, name, levelTypes, hidden?, level }
 *                                        writes public/levels/<id>.json + upserts manifest
 *   POST /__dev/levels/sethidden       → { id, hidden } toggles the manifest hidden flag
 *   POST /__dev/levels/delete          → { id } removes the file + manifest entry
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface ManifestEntry {
  id: string;
  name: string;
  file: string;
  levelTypes?: string[];
  hidden?: boolean;
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Serialize the manifest with one compact level object per line, matching the
 *  hand-authored style — `{ "id": "x", ... }` with inner spaces — so git diffs
 *  stay one-line-per-map and only changed entries show up. */
function serializeManifest(manifest: { levels: ManifestEntry[] }): string {
  const formatEntry = (l: ManifestEntry): string => {
    const parts = Object.entries(l).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    return `{ ${parts.join(', ')} }`;
  };
  const lines = manifest.levels.map(l => '    ' + formatEntry(l));
  return `{\n  "levels": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

function sendJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}

export function devMapsPlugin(): any {
  return {
    name: 'bb-dev-maps',
    apply: 'serve',
    configureServer(server: any) {
      const levelsDir = path.resolve(server.config.root, 'public', 'levels');
      const manifestPath = path.join(levelsDir, 'manifest.json');

      const loadManifest = (): { levels: ManifestEntry[] } => {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        return JSON.parse(raw);
      };

      server.middlewares.use('/__dev/levels', async (req: any, res: any) => {
        try {
          const url = req.url || '/';

          if (req.method === 'GET' && url.startsWith('/manifest')) {
            sendJson(res, 200, loadManifest());
            return;
          }

          if (req.method === 'POST' && url.startsWith('/save')) {
            const { id, name, levelTypes, hidden, level } = JSON.parse(await readBody(req));
            if (typeof id !== 'string' || !SLUG_RE.test(id)) {
              sendJson(res, 400, { error: `Invalid id "${id}". Use lowercase letters, numbers and dashes.` });
              return;
            }
            if (!level || typeof level !== 'object') {
              sendJson(res, 400, { error: 'Missing level data.' });
              return;
            }

            const file = `${id}.json`;
            // Persist the map JSON itself (pretty-printed for readable git diffs).
            fs.writeFileSync(path.join(levelsDir, file), JSON.stringify(level, null, 2) + '\n', 'utf8');

            // Upsert the manifest entry, preserving order and any sibling entries.
            const manifest = loadManifest();
            const entry: ManifestEntry = {
              id,
              name: name || level.name || id,
              file,
              levelTypes: Array.isArray(levelTypes) ? levelTypes : [],
            };
            if (hidden) entry.hidden = true;
            const idx = manifest.levels.findIndex(l => l.id === id);
            if (idx >= 0) manifest.levels[idx] = { ...manifest.levels[idx], ...entry };
            else manifest.levels.push(entry);
            fs.writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');

            sendJson(res, 200, { ok: true, id, file });
            return;
          }

          if (req.method === 'POST' && url.startsWith('/sethidden')) {
            const { id, hidden } = JSON.parse(await readBody(req));
            if (typeof id !== 'string' || !SLUG_RE.test(id)) {
              sendJson(res, 400, { error: `Invalid id "${id}".` });
              return;
            }
            const manifest = loadManifest();
            const entry = manifest.levels.find(l => l.id === id);
            if (!entry) {
              sendJson(res, 404, { error: `No map "${id}" in manifest.` });
              return;
            }
            if (hidden) entry.hidden = true;
            else delete entry.hidden;
            fs.writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');
            sendJson(res, 200, { ok: true, id, hidden: !!hidden });
            return;
          }

          if (req.method === 'POST' && url.startsWith('/delete')) {
            const { id } = JSON.parse(await readBody(req));
            if (typeof id !== 'string' || !SLUG_RE.test(id)) {
              sendJson(res, 400, { error: `Invalid id "${id}".` });
              return;
            }
            const manifest = loadManifest();
            const entry = manifest.levels.find(l => l.id === id);
            manifest.levels = manifest.levels.filter(l => l.id !== id);
            fs.writeFileSync(manifestPath, serializeManifest(manifest), 'utf8');
            if (entry) {
              const fp = path.join(levelsDir, entry.file);
              if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }
            sendJson(res, 200, { ok: true, id });
            return;
          }

          sendJson(res, 404, { error: 'Unknown dev-maps route' });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? String(err) });
        }
      });

      // ── Single-player "Play" campaign editing ──────────────────────────
      // Lets the level designer define/reorder the campaign and persist it to
      // public/campaigns/<id>.json. Serve-only, like the maps endpoints above.
      const campaignsDir = path.resolve(server.config.root, 'public', 'campaigns');

      server.middlewares.use('/__dev/campaigns', async (req: any, res: any) => {
        try {
          const url = req.url || '/';

          if (req.method === 'GET') {
            // /__dev/campaigns/<id>
            const id = url.replace(/^\/+/, '').split('?')[0] || 'play';
            if (!SLUG_RE.test(id)) {
              sendJson(res, 400, { error: `Invalid campaign id "${id}".` });
              return;
            }
            const fp = path.join(campaignsDir, `${id}.json`);
            if (!fs.existsSync(fp)) {
              sendJson(res, 404, { error: `No campaign "${id}".` });
              return;
            }
            sendJson(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
            return;
          }

          if (req.method === 'POST' && url.startsWith('/save')) {
            const { id, name, levels } = JSON.parse(await readBody(req));
            if (typeof id !== 'string' || !SLUG_RE.test(id)) {
              sendJson(res, 400, { error: `Invalid campaign id "${id}".` });
              return;
            }
            if (!Array.isArray(levels) || levels.some((l: any) => typeof l?.id !== 'string')) {
              sendJson(res, 400, { error: 'levels must be an array of { id, name? }.' });
              return;
            }
            // Every referenced level must be a known builtin map.
            const known = new Set(loadManifest().levels.map((l) => l.id));
            const unknown = levels.map((l: any) => l.id).filter((lid: string) => !known.has(lid));
            if (unknown.length > 0) {
              sendJson(res, 400, { error: `Unknown level id(s): ${unknown.join(', ')}` });
              return;
            }
            const clean = {
              id,
              name: name || id,
              levels: levels.map((l: any) => (l.name ? { id: l.id, name: l.name } : { id: l.id })),
            };
            fs.mkdirSync(campaignsDir, { recursive: true });
            fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify(clean, null, 2) + '\n', 'utf8');
            sendJson(res, 200, { ok: true, id });
            return;
          }

          sendJson(res, 404, { error: 'Unknown dev-campaigns route' });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? String(err) });
        }
      });
    },
  };
}
