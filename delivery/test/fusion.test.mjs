// Fusion rule tests. Run: node --experimental-strip-types test/fusion.test.mjs
import { fuseHolds } from "../app/fusion.ts";

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}: ${d}`); };
const cam = (secs, avg, endMs) => ({ type: "handstand", secs, avg, min: avg - 5, at: new Date(endMs).toISOString(), _end: endMs });
const endOf = e => e._end;

{ // clean match within the window
  const out = fuseHolds([cam(20, 88, 100000)], [{ secs: 19.5, stab: 84, endedAtMs: 100800 }], endOf);
  check("fuses within 2 s", out[0].source === "fused" && out[0].boardStability === 84, JSON.stringify(out[0].source));
}
{ // outside the window: no fusion
  const out = fuseHolds([cam(20, 88, 100000)], [{ secs: 20, stab: 84, endedAtMs: 104000 }], endOf);
  check("no fusion at +4 s", out[0].source === "camera" && out[0].boardStability === undefined, out[0].source);
}
{ // duration disagreement: someone ELSE's hold ended nearby — reject
  const out = fuseHolds([cam(25, 90, 100000)], [{ secs: 6, stab: 70, endedAtMs: 100500 }], endOf);
  check("duration mismatch rejected", out[0].source === "camera", `25s vs 6s must not fuse`);
}
{ // two camera holds, two board holds: each matches its own, no double-use
  const out = fuseHolds([cam(10, 80, 50000), cam(15, 85, 90000)],
    [{ secs: 10.2, stab: 77, endedAtMs: 50300 }, { secs: 14.8, stab: 91, endedAtMs: 89600 }], endOf);
  check("pairwise matching", out[0].boardStability === 77 && out[1].boardStability === 91,
        JSON.stringify(out.map(o => o.boardStability)));
}
{ // one board hold cannot fuse to two camera holds
  const out = fuseHolds([cam(10, 80, 50000), cam(10, 82, 51000)],
    [{ secs: 10, stab: 77, endedAtMs: 50200 }], endOf);
  const fused = out.filter(o => o.source === "fused").length;
  check("board hold used once", fused === 1, `${fused} fused`);
}
{ // non-handstand entries pass through untouched
  const out = fuseHolds([{ type: "pushups", secs: undefined, avg: 90, min: 0, at: "", _end: 0, reps: 10 }],
    [{ secs: 10, stab: 77, endedAtMs: 100 }], endOf);
  check("non-handstand passthrough", out[0].source === "camera" && out[0].boardStability === undefined, out[0].type);
}
console.log(`\n${pass}/${pass + fail} fusion checks pass`);
process.exit(fail ? 1 : 0);
