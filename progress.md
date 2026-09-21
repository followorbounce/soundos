# Progress — SoundOS

## Status

- MVP working: full node library (generators, processing, Character/Time nodes ported from Pulse Train, Video Output), visual patch editor with zoom/pan/cables/oscilloscopes, Speed (global varispeed), Compact layout mode, undo/redo, 9 tuning presets, Chance/Stage performance buttons.
- Known simplifications (by design, not bugs): single graph/no polyphony, structural patch edits rebuild the whole graph live (can click/pop), export/import is JSON-patch only (no standalone HTML player).
- Git: clean working tree, `main` up to date with `origin/main` (github.com/followorbounce/soundos).

## Recent work

- 2026-09-21 — Per-node live taping: two buttons beside each node's bypass switch (● record, ▶ loop). First click records every change to that node's settings (any source: knob, switch, select, Chance, preset), second click stops, auto-stop at 4 s; ▶ loops the take (restores starting values, replays timestamped moves) until clicked again. New `js/recorder.js`; takes live in `state.loops`, survive undo, and are saved/restored with Export/Import. Verified in headless Firefox (record → loop playback → knob display follows → undo/delete/restore). Nodes with no params (Null) get no buttons. Not committed yet.

- 2026-09-16 — Added CLAUDE.md and progress.md for ongoing tracking.
- 2026-09-16 (bb896d5) — up.
- 2026-09-16 (9db13c9) — Lay out the starter rack as one lane per signal chain, not by type.
- 2026-09-16 (2147888) — Left-to-right signal flow, a Null junction node, and Compact auto-packing.
- 2026-09-16 (574da90) — Translate all remaining Russian to English.
- 2026-09-16 (3af4dde) — Add a global Speed control (varispeed for the whole patch).
- 2026-09-16 (5ad0058) — Make connecting a wire as forgiving as disconnecting one.
- 2026-09-16 (7507dee) — Make Compact mode independent of CSS cascade; remove Kill.
- 2026-09-16 (7ca6b18) — Rework playback into a permanent, no-keyboard modular graph; add Pulse Train node/style parity.
- 2026-09-16 (a8f75b5) — Restyle nodes to match Pulse Train — Stage II look.
- 2026-09-16 (2591adc) — Scaffold SoundOS: modular synth builder web app.

- 2026-09-19 — Added a Cloudflare Web Analytics beacon (cross-repo rollout across every deployed followorbounce/client site). See [[cloudflare-analytics-setup]] in the assistant's memory for the account/token map.

## Next steps (from README "Ideas for later")

- Export a patch to a standalone HTML file that plays with no editor.
- Snap-to-grid for ordinary dragging.
- Surgical live re-patching (add/remove a single cable/node with no full rebuild/click).
- MIDI input as a CV source (frequency/gate) for generators.
