// Cross-verify scorer.js against Python-generated test_vectors.json (<1e-6).
import { readFileSync } from "fs";
import { handstandScore, isInverted, RepCounter } from "../app/scorer.ts";

const V = JSON.parse(readFileSync(new URL("./test_vectors.json", import.meta.url)));
let pass = 0, fail = 0;
const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

for (const c of V.handstand) {
  const r = handstandScore(c.wri, c.sho, c.hip, c.kne, c.ank);
  const ok = close(r.score, c.expect.score, 1e-3) && close(r.shoulder, c.expect.shoulder, 1e-3)
    && close(r.hip, c.expect.hip, 1e-3) && close(r.lean, c.expect.lean, 1e-3)
    && r.cue === c.expect.cue && isInverted(c.wri, c.sho, c.hip, c.ank);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  handstand/${c.name}: js ${r.score.toFixed(4)} vs py ${c.expect.score} · cue "${r.cue}"`);
}
for (const c of V.pushup_reps) {
  const rc = new RepCounter();
  for (const [elbow, dev] of c.frames) rc.feed(elbow, dev);
  const ok = rc.reps.length === c.expect.length
    && rc.reps.every((r, i) => close(r.score, c.expect[i].score, 1e-3) && r.cue === c.expect[i].cue);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  pushup/${c.name}: ${rc.reps.length} reps, js ${rc.reps.map(r => r.score.toFixed(2))} vs py ${c.expect.map(r => r.score)}`);
}
console.log(`\n${pass}/${pass + fail} core vector groups match`);

// ---- extended movements (squat / plank / pull-up) ----
import { SquatCounter, plankScore, PullupCounter } from "../app/scorer.ts";
let pass2 = 0, fail2 = 0;
for (const c of V.squat_reps) {
  const sc = new SquatCounter();
  for (const [k, l] of c.frames) sc.feed(k, l);
  const ok = sc.reps.length === c.expect.length
    && sc.reps.every((r, i) => close(r.score, c.expect[i].score, 1e-3) && r.cue === c.expect[i].cue);
  ok ? pass2++ : fail2++;
  console.log(`${ok ? "PASS" : "FAIL"}  squat/${c.name}: ${sc.reps.length} reps, js ${sc.reps.map(r => r.score.toFixed(2))}`);
}
for (const c of V.plank) {
  const ok = close(plankScore(c.dev), c.expect, 1e-3);
  ok ? pass2++ : fail2++;
  console.log(`${ok ? "PASS" : "FAIL"}  plank/dev${c.dev}: ${plankScore(c.dev)} vs ${c.expect}`);
}
for (const c of V.pullup_reps) {
  const pc = new PullupCounter();
  for (const e of c.frames) pc.feed(e);
  const ok = pc.reps.length === c.expect.length
    && pc.reps.every((r, i) => close(r.score, c.expect[i].score, 1e-3) && r.cue === c.expect[i].cue);
  ok ? pass2++ : fail2++;
  console.log(`${ok ? "PASS" : "FAIL"}  pullup/${c.name}: ${pc.reps.length} reps, js ${pc.reps.map(r => r.score.toFixed(1))}`);
}
console.log(`extended: ${pass2}/${pass2 + fail2} groups match`);
process.exit(fail || fail2 ? 1 : 0);
