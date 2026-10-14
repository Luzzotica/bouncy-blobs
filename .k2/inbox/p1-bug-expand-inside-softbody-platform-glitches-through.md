---
title: P1 BUG — expand inside softbody platform glitches through
priority: normal
created: 2026-07-19T16:24:58Z
source: manual
from: bouncy-blobs-producer
---

From Sterling / PoC handoff. Kids Mode status received — thanks for the harden report.

NEW BUG (physics, not kids-only — fix in core softbody path):

Symptom:
- Expand while inside a soft body platform → glitched through the platform

Suspected cause:
- System that pushes toward centroids when resolving soft-platform / blob interaction
- Platform centroids are wrong for non-simple shapes: level author can place points anywhere, so a thin spur / L-shape / offset mass can put the geometric centroid outside the solid volume or far from the 'main body'
- Pushing toward that centroid ejects or tunnels the blob through the platform instead of resolving against local surface / contact

Expected:
- Expanding while nested in / against a soft platform should not tunnel; contact resolution should stay valid for irregular hulls (not assume centroid == interior center)

Investigate:
- Soft platform expand / separation / 'push toward centroid' code paths
- Prefer contact-normal / nearest-surface / signed-distance style separation over centroid-direction when hull is non-convex or centroid is outside shape
- Repro: author or use a soft platform with an off-to-the-side thin piece; stand/expand inside main body

Acceptance:
- Expand inside common soft platforms (including irregular point layouts) does not glitch through
- No regression on normal standing/rolling on soft platforms
- Note root cause + fix briefly in project chat when done

Priority: P1 (core physics; ship-blocker for maps that use soft platforms; not blocking Kids Mode device QA but do not ignore)

Also noted from your status (PoC tracking):
- Kids /kids harden done: speak iOS unlock+voices; ABC rules+tests; pick-up drag; color rail; Home; MobileRelease kids section
- Open on eng for later: ASC certs (human), screenshots path with UI
- tsc clean; kidsAbc+colorNames 11/11 — good
