// Verifies app/scorer.ts against the Python-reference test vectors.
// Run: node --experimental-strip-types test/scorer.test.mjs   (node >= 22.6)
// KEEP IN CI: if this fails after a port/refactor, the maths drifted from the reference.
import { readFileSync } from "fs";
import { handstandScore, isInverted, RepCounter } from "../app/scorer.ts";

const V = JSON.parse(readFileSync(new URL("./test_vectors.json", import.meta.url)));
let pass = 0, fail = 0;
const close = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

for (const c of V.handstand) {
  const r = handstandScore(c.wri, c.sho, c.hip, c.kne, c.ank);
  const ok = close(r.score, c.expect.score) && close(r.shoulder, c.expect.shoulder)
    && close(r.hip, c.expect.hip) && close(r.lean, c.expect.lean)
    && r.cue === c.expect.cue && isInverted(c.wri, c.sho, c.hip, c.ank);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  handstand/${c.name}: ts ${r.score.toFixed(4)} vs py ${c.expect.score}`);
}
for (const c of V.pushup_reps) {
  const rc = new RepCounter();
  for (const [elbow, dev] of c.frames) rc.feed(elbow, dev);
  const ok = rc.reps.length === c.expect.length
    && rc.reps.every((r, i) => close(r.score, c.expect[i].score) && r.cue === c.expect[i].cue);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  pushup/${c.name}: ${rc.reps.length} reps`);
}
console.log(`\n${pass}/${pass + fail} vector groups match the Python reference`);
process.exit(fail ? 1 : 0);
