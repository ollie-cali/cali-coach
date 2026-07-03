# Cali Coach → CaliDev integration package

*[Maker Ollie delivery, 2026-07-03 overnight] Live demo: **https://ollie-cali.github.io/cali-coach/** (open on a phone, side-on at an athlete). This folder is the production port, ready to drop in. Mirrored at github.com/ollie-cali/cali-coach (branch `delivery`).*

## What's verified vs what's yours to verify

**VERIFIED (don't re-derive, keep the tests in CI):**
- `app/scorer.ts` — the scoring maths. Matches the Python reference **10/10 test-vector groups** (`npm test` → `test/scorer.test.mjs` + `test_vectors.json`). Node ≥22.6 runs it directly via `--experimental-strip-types`.
- `app/useCoachSession.ts` (`CoachEngine`) — the full mode/session state machine (hold debounce, glitch immunity, set closing). **9/9 headless integration checks** (`test/engine.test.mjs`). Pure TS, no camera/DOM/RN dependency — works in a worklet, a hook, or jest.
- The BLE UUID contract in `app/useCaliBoard.ts` — matches the compile-verified board firmware (maker-ollie-brain `models/handstand-board-v1/firmware_v2`).

**YOURS TO VERIFY (marked in-file):** pose-plugin choice + its API (options listed in `CoachCameraScreen.tsx`), `react-native-webview` / `ble-plx` versions, table/column naming in the migration.

## Build order (fastest value first)

1. **Today — WebView tier:** `app/CoachWebViewScreen.tsx` → a nav entry "Coach (beta)". Zero native work; the demo page runs entirely on-device. Add the postMessage bridge later so even this tier writes `coach_sessions`.
2. **Backend:** apply `supabase/migration_coach_sessions.sql` (adjust to house conventions), deploy `supabase/functions_coach-summary_index.ts` as `coach-summary`, set `ANTHROPIC_API_KEY` secret. Then the web demo's paste-a-key field can die.
3. **Native tier:** pick a pose plugin (A/B/C options in `CoachCameraScreen.tsx`), feed 33 MediaPipe-order landmarks into `CoachEngine.feed(lm, now)` — everything downstream is done and tested. Wire `engine.onLog` → `coach_sessions` insert (snippet in `useCoachSession.ts`).
4. **Skill Swirl hook:** the `coach_best` view gives camera-verified evidence per member/kind → gate level unlocks on it (e.g. handstand ≥15 s at avg ≥80). **This makes belt/colour unlocks self-refereeing** — ties directly into `colour_tiers` + `member_unlocked_colours()`.
5. **Board fusion:** `useCaliBoard.ts` — merge board holdEnd with camera holds (±2 s) → `source='fused'` rows. The board's record button already commands the phone to film.

## The one-line pitch to keep everyone honest
Pose estimation is a commodity; **the moat is the calisthenics-specific scoring (this package), the Skill Swirl standard, and the board fusion.** Guard the maths: any change to `scorer.ts` must keep the test vectors passing or regenerate them from the Python reference with a documented reason.

## Tuning backlog (after the first live session)
- Threshold pass with real athletes: horizontal band (0.28), visibility gate (0.4), debounce times.
- Weight calibration: ~20 coach-judged clips vs engine scores → refit the four handstand weights + push-up mix.
- MediaPipe `lite` → `full` model if inverted-pose tracking wobbles (one URL in the web app; plugin setting natively).
- Next scorers (same pattern, ~30 lines each): L-sit, plank, pull-up (vertical chain).
