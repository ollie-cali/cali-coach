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

// ================== extended movements ==================
// rotate helper: place point at angle th (deg) at joint J relative to ref point R
function place(J, R, thDeg, len) {
  const ux = R[0]-J[0], uy = R[1]-J[1], n = Math.hypot(ux, uy);
  const th = thDeg * Math.PI / 180;
  return [J[0] + (ux/n*Math.cos(th) - uy/n*Math.sin(th)) * len,
          J[1] + (ux/n*Math.sin(th) + uy/n*Math.cos(th)) * len];
}
// squat frame: standing chain, knee angle controlled by moving the ankle about the knee
function squatF(kneeDeg) {
  const hip = [0.5, 0.55], kne = [0.5, 0.725];
  const ank = place(kne, hip, kneeDeg, 0.175);
  return frame({ sho: [0.5, 0.35], elb: [0.52, 0.55], wri: [0.53, 0.72], hip, kne, ank });
}
// pull-up frame: hanging chain, elbow angle controlled by moving the wrist about the elbow
function pullF(elbowDeg) {
  const sho = [0.5, 0.42], elb = [0.47, 0.31];
  const wri = place(elb, sho, elbowDeg, 0.12);
  return frame({ sho, elb, wri, hip: [0.5, 0.62], kne: [0.5, 0.78], ank: [0.5, 0.92] });
}

// ---- scenario 4: 3 squats then idle -> one set of 3 ----
{
  const e = new CoachEngine(); let t = 0, out;
  const sweep = [];
  for (let k = 0; k < 3; k++) {
    for (let a = 175; a > 88; a -= 5) sweep.push(a);
    for (let a = 88; a <= 175; a += 5) sweep.push(a);
  }
  for (const a of sweep) out = e.feed(squatF(a), t += 33);
  check("squat mode + 3 reps live", out.mode === "SQUAT" && out.reps === 3, `${out.mode} reps ${out.reps} score ${out.score?.toFixed(0)}`);
  for (let i = 0; i < 160; i++) out = e.feed(squatF(178), t += 33);   // stand still 5s
  check("squat set logged", e.session.length === 1 && e.session[0].type === "squats" && e.session[0].reps === 3,
        JSON.stringify(e.session));
}

// ---- scenario 5: 6 s straight-arm plank -> one plank hold, NO push-up set ----
{
  const e = new CoachEngine(); let t = 0, out;
  for (let i = 0; i < 182; i++) out = e.feed(pushup(172), t += 33);   // 6 s horizontal, arms straight
  check("plank mode engages", out.mode === "PLANK" && out.holdSecs > 2, `${out.mode} ${out.holdSecs?.toFixed(1)}s score ${out.score?.toFixed(0)}`);
  for (let i = 0; i < 60; i++) out = e.feed(STAND, t += 33);          // stand up 2 s
  check("plank logged, not pushups", e.session.length === 1 && e.session[0].type === "plank" && e.session[0].secs > 4,
        JSON.stringify(e.session));
}

// ---- scenario 6: push-ups do NOT log a plank (disambiguation) ----
{
  const e = new CoachEngine(); let t = 0;
  const sweep = [];
  for (let k = 0; k < 3; k++) {
    for (let a = 170; a > 85; a -= 5) sweep.push(a);
    for (let a = 85; a <= 170; a += 5) sweep.push(a);
  }
  for (const a of sweep) e.feed(pushup(a), t += 33);
  for (let i = 0; i < 120; i++) e.feed(STAND, t += 33);
  const types = e.session.map(s => s.type);
  check("pushups only, no phantom plank", e.session.length === 1 && types[0] === "pushups", JSON.stringify(types));
}

// ---- scenario 7: 3 pull-ups hanging -> one set ----
{
  const e = new CoachEngine(); let t = 0, out;
  const sweep = [];
  for (let k = 0; k < 3; k++) {
    for (let a = 175; a > 58; a -= 6) sweep.push(a);
    for (let a = 58; a <= 175; a += 6) sweep.push(a);
  }
  for (const a of sweep) out = e.feed(pullF(a), t += 33);
  check("pull-up mode + 3 reps", out.mode === "PULL-UP" && out.reps === 3, `${out.mode} reps ${out.reps} score ${out.score?.toFixed(0)}`);
  for (let i = 0; i < 120; i++) out = e.feed(STAND, t += 33);
  check("pull-up set logged", e.session.length === 1 && e.session[0].type === "pullups" && e.session[0].reps === 3,
        JSON.stringify(e.session));
}


// ================== skill + mobility holds ==================
// front lever: hanging, body horizontal (wrists above shoulders)
function leverF(hipA = 180) {
  const sho = [0.35, 0.55], wri = [0.33, 0.40], elb = [0.34, 0.47];
  const hip = [sho[0] + 0.18, sho[1]];
  const t2 = (180 - hipA) * Math.PI / 180;
  const kne = [hip[0] + 0.15*Math.cos(t2), hip[1] + 0.15*Math.sin(t2)];
  const ank = [kne[0] + 0.15*Math.cos(t2), kne[1] + 0.15*Math.sin(t2)];
  return frame({ sho, elb, wri, hip, kne, ank });
}
// L-sit: torso vertical, support hands by hips, legs straight out horizontal
const LSIT = frame({ sho: [0.5, 0.38], elb: [0.51, 0.5], wri: [0.52, 0.62],
                     hip: [0.5, 0.6], kne: [0.65, 0.6], ank: [0.8, 0.6] });
// pike: seated fold ~40 deg
function pikeF() {
  const hip = [0.5, 0.75], ank = [0.8, 0.75];
  const a = -40 * Math.PI / 180;
  const sho = [hip[0] + 0.22*Math.cos(a), hip[1] + 0.22*Math.sin(a)];
  return frame({ sho, elb: [sho[0]+0.1, sho[1]+0.05], wri: [sho[0]+0.18, sho[1]+0.1],
                 hip, kne: [0.65, 0.75], ank });
}
// bridge: hips the high point, hands + feet down
const BRIDGE = frame({ wri: [0.35, 0.85], sho: [0.35, 0.73], hip: [0.35, 0.53],
                       elb: [0.35, 0.79], kne: [0.37, 0.36], ank: [0.55, 0.88] });

function holdScenario(name, mkFrame, expectType, minScore, maxScore) {
  const e = new CoachEngine(); let t = 0, out;
  for (let i = 0; i < 150; i++) out = e.feed(mkFrame, t += 33);      // ~5 s in posture
  const modeOk = out.mode !== "READY" && out.mode !== "IN FRAME";
  for (let i = 0; i < 60; i++) out = e.feed(STAND, t += 33);         // leave 2 s
  const s = e.session;
  const ok = modeOk && s.length === 1 && s[0].type === expectType
    && s[0].secs > 3 && s[0].avg >= minScore && s[0].avg <= maxScore;
  check(`${name} hold`, ok, JSON.stringify(s) + (modeOk ? "" : " (mode never engaged)"));
}
holdScenario("front lever (textbook)", leverF(180), "front_lever", 95, 100);
holdScenario("front lever (piked 155)", leverF(155), "front_lever", 40, 75);
holdScenario("L-sit", LSIT, "lsit", 75, 100);
holdScenario("pike fold", pikeF(), "pike", 60, 100);
holdScenario("bridge", BRIDGE, "bridge", 85, 100);

// disambiguation: bridge must NOT read as plank/push-up; L-sit must NOT log squats
{
  const e = new CoachEngine(); let t = 0;
  for (let i = 0; i < 150; i++) e.feed(BRIDGE, t += 33);
  for (let i = 0; i < 60; i++) e.feed(STAND, t += 33);
  check("bridge is not a plank", e.session.length === 1 && e.session[0].type === "bridge",
        JSON.stringify(e.session.map(s => s.type)));
}
{
  const e = new CoachEngine(); let t = 0;
  for (let i = 0; i < 150; i++) e.feed(LSIT, t += 33);
  for (let i = 0; i < 60; i++) e.feed(STAND, t += 33);
  check("L-sit logs no squats", e.session.every(s => s.type === "lsit"),
        JSON.stringify(e.session.map(s => s.type)));
}

console.log(`\nTOTAL: ${pass}/${pass + fail} engine checks pass`);
process.exit(fail ? 1 : 0);
