# Zee — Third-Party Dependencies & Originality Statement

## Explicit non-use statement
Zee — The Gen Z Guide is an **original, independent, clean-room work of Gen Z Digital Store**. In
creating it we did **not** clone, download, fork, inspect, import, or modify **Bible Strong Avatar
Lab**; did not install any `@bible-strong` package; and did not copy its source code, folder
structure, JSON/avatar schema, SVG paths, assets, shapes, expressions, animation data, controller
API, or Studio UI. No external copyrighted character artwork or screenshots were used or traced. The
name "Bible Strong" appears in this repository only in this kind of legal/design non-use note and in
the separate client-assistant AGPL-reference documentation — never as an implementation dependency.

## Dependencies used by the Zee engine (all already in `frontend/package.json`)
| Package | Version (installed range) | Licence | Use |
|---|---|---|---|
| `react` / `react-dom` | ^19.0.0 | MIT | Components |
| `framer-motion` | ^12.40.0 | MIT | Subtle panel/avatar transitions (only where it adds value) |
| `lucide-react` | ^0.507.0 | ISC | Existing CSS fallback icons (unchanged) |

**No new dependency was added.** No 3D engine, no additional animation library, no `@bible-strong`
package. All SVG geometry, the avatar schema, the state machine, animation timings, and the hook/
component APIs were authored specifically for this repository.
