// Integration test of CoachEngine: drives the full mode/session state machine
// with synthetic landmark streams (no camera). Run: node --experimental-strip-types test/engine.test.mjs
import { CoachEngine } from "../app/useCoachSession.ts";

const L = { sho: 11, elb: 13, wri: 15, hip: 23, kne: 25, ank: 27 };
function frame(points, vis = 1) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  for (const [k, [x, y]] of Object.entries(points)) lm[L[k]] = { x, y, visibility: vis };
  return lm;
}
// perfect handstand chain (wrists at bottom, stacked vertical)
const HS = frame({ wri: [0.5, 0.90], elb: [0.5, 0.81], sho: [0.5, 0.72], hip: [0.5, 0.504], kne: [0.5, 0.324], ank: [0.5, 0.144] });
// standing (visible, neither inverted nor horizontal)
const STAND = frame({ wri: [0.52, 0.75], elb: [0.51, 0.6], sho: [0.5, 0.40], hip: [0.5, 0.60], kne: [0.5, 0.75], ank: [0.5, 0.90] });
// push-up frame with a controllable elbow angle
function pushup(elbowDeg) {
  const sho = [0.30, 0.50], elb = [0.29, 0.61];
  const ux = sho[0]-elb[0], uy = sho[1]-elb[1], n = Math.hypot(ux, uy);
  const th = (elbowDeg * Math.PI) / 180;
  // rotate the unit elb->sho vector by elbowDeg to place the wrist
  const wx = (ux/n)*Math.cos(th) - (uy/n)*Math.sin(th), wy = (ux/n)*Math.sin(th) + (uy/n)*Math.cos(th);
  return frame({ sho, elb, wri: [elb[0] + wx*0.12, elb[1] + wy*0.12], hip: [0.48, 0.52], kne: [0.57, 0.53], ank: [0.66, 0.54] });
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}: ${detail}`); };

// ---- scenario 1: a 3.5 s perfect handstand, then stand up ----
{
  const e = new CoachEngine(); let t = 0, out;
  for (let i = 0; i < 30; i++) out = e.feed(STAND, t += 33);          // 1 s standing
  check("standing reads IN FRAME", out.mode === "IN FRAME", out.mode);
  for (let i = 0; i < 106; i++) out = e.feed(HS, t += 33);            // 3.5 s inverted
  check("hold activates", out.mode === "HANDSTAND", `${out.mode}, score ${out.score?.toFixed(1)}`);
  check("perfect scores ~100", out.score > 97, `smoothed ${out.score?.toFixed(1)}`);
  check("timer runs", out.holdSecs > 2.5 && out.holdSecs < 3.6, `${out.holdSecs?.toFixed(1)}s`);
  for (let i = 0; i < 40; i++) out = e.feed(STAND, t += 33);          // stand up 1.3 s
  check("hold logged once", e.session.length === 1, JSON.stringify(e.session));
  const h = e.session[0];
  check("logged secs ≈ 3.0 (hold minus start debounce)", h.type === "handstand" && h.secs > 2.4 && h.secs < 3.6, `${h.secs}s avg ${h.avg}`);
}

// ---- scenario 2: glitch frame mid-hold must NOT split the hold (the sim S4 lesson) ----
{
  const e = new CoachEngine(); let t = 0;
  for (let i = 0; i < 90; i++) e.feed(HS, t += 33);                   // 3 s in
  e.feed(STAND, t += 33);                                             // ONE bad frame (33 ms)
  for (let i = 0; i < 60; i++) e.feed(HS, t += 33);                   // 2 s more
  for (let i = 0; i < 40; i++) e.feed(STAND, t += 33);                // end
  check("glitch survived: exactly 1 hold", e.session.length === 1, JSON.stringify(e.session.map(s => s.secs)));
}

// ---- scenario 3: 3 push-ups then rest -> one set of 3 logged ----
{
  const e = new CoachEngine(); let t = 0, out;
  const sweep = [];
  for (let k = 0; k < 3; k++) {
    for (let a = 170; a > 85; a -= 5) sweep.push(a);
    for (let a = 85; a <= 170; a += 5) sweep.push(a);
  }
  for (const a of sweep) out = e.feed(pushup(a), t += 33);
  check("push-up mode + 3 reps live", out.mode === "PUSH-UP" && out.reps === 3, `${out.mode} reps ${out.reps} score ${out.score?.toFixed(0)}`);
  for (let i = 0; i < 120; i++) out = e.feed(STAND, t += 33);         // 4 s idle -> set closes
  check("set logged", e.session.length === 1 && e.session[0].type === "pushups" && e.session[0].reps === 3,
        JSON.stringify(e.session));
}

console.log(`\n${pass}/${pass + fail} engine checks pass`);
process.exit(fail ? 1 : 0);
