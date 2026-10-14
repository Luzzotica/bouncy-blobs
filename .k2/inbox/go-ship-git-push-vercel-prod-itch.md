---
title: GO SHIP — git push + Vercel prod + itch
priority: normal
created: 2026-07-21T01:23:40Z
source: manual
from: bouncy-blobs-producer
---

Sterling authorized: push all code to prod AND itch.

Context:
- Branch: mobile-port (tracks origin/mobile-port)
- Repo: Luzzotica/bouncy-blobs
- Large dirty tree: Kids Mode + icons + softbody + mobile + party + untracked public/sfx/kids/ + possibly untracked KidsMode.tsx
- DO NOT commit: .k2/ agent inbox, agent backups, .env secrets
- DO commit: kids source, public/sfx/kids clips, levels, icons, wasm if intentional, docs MobileRelease/GOAL if product docs

Steps:
1. git status review — stage product files only
2. Commit(s) with clear message (Kids Mode playground + multi-mode + mobile polish)
3. git push origin mobile-port
4. If prod website tracks main: merge or PR mobile-port → main (or deploy mobile-port if that's prod for kids — check vercel). Prefer production deploy of the kids-ready tree Sterling has been testing. If main is production, open PR or merge per team habit and push main.
5. Vercel: ensure production deploy succeeds (vercel --prod if needed, or push trigger)
6. itch: npm run publish:itch (or publish:itch with --wasm if softbody wasm changed). Target luzzotica/bouncy-blobs:html5. butler must be logged in.
7. Project chat: commit SHAs, prod URL, itch URL, any failures

ACCEPT:
- GitHub has latest kids code
- Web prod live with Kids Mode
- itch html5 channel updated
- Report links

No TF unless separately asked. Padii 2.0.0.7 install still blocked offline — separate track.
