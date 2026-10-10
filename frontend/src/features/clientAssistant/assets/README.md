# Gen Z Guide — avatar asset

**No `.avatar.json` is bundled here yet, and none is required for the assistant to work.** The
assistant ships with an accessible, dependency-free CSS/lucide avatar fallback (see
`../AvatarRenderer.js`). A richer avatar is an optional, licence-gated enhancement — see
`docs/CLIENT_AVATAR_ASSISTANT.md` (Licensing).

## Why there is no avatar.json
The reference runtime (`@bible-strong/avatar-react`, currently `0.1.0` on npm) is **AGPL-licensed**.
This repository has **no documented AGPL-compliance / commercial-licence approval**, so the runtime
is **not** installed or bundled, and no exported definition exists. Do **not** fabricate one.

## How to add a real avatar later (once licensing is approved)
1. Open the Avatar Studio (reference: https://avatars.bible-strong.app/).
2. Create the expressions and animations you want. Suggested semantic set:
   - Expressions: `neutral, listening, thinking, happy, warning, sad, confused`
   - Animations: `idle, wave, talk, celebrate, error, point-left, point-right`
   (The app does **not** assume these keys exist — `../avatarStates.js` maps semantic states to
   whatever keys the file actually declares and falls back safely to neutral/idle.)
3. Export the runtime definition and save it here as **`genz-guide.avatar.json`**.
4. Install the approved runtime at the pinned version, e.g. `@bible-strong/avatar-react@0.1.0`
   (confirm the exact approved version), honouring its licence notices.
5. Wire it through the single integration point: pass a `renderer` adapter and the parsed
   `definition` to `AvatarRenderer` (`{ mount(el,{definition}), setState(keys), destroy() }`).
   Nothing else in the feature changes — all components speak only in semantic states.

If the definition is missing, partial, or a key is absent, the renderer never crashes: it uses the
CSS fallback or the nearest safe key.
