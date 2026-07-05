// CaliCoach scoring engine (production). MUST match scoring_reference.py to <1e-6
// — verified by test_scorer.mjs against test_vectors.json. Pure functions, no DOM.
// Angles in degrees. Coordinates normalised, y DOWN (MediaPipe convention).

export const POSE = { nose:0, l_sho:11, r_sho:12, l_elb:13, r_elb:14, l_wri:15, r_wri:16,
                      l_hip:23, r_hip:24, l_kne:25, r_kne:26, l_ank:27, r_ank:28 };

export function angleAt(A, B, C) {
  const v1x = A[0]-B[0], v1y = A[1]-B[1], v2x = C[0]-B[0], v2y = C[1]-B[1];
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n === 0) return 180;
  const d = Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / n));
  return Math.acos(d) * 180 / Math.PI;
}

export function leanFromVertical(P, Q) {
  return Math.atan2(Math.abs(Q[0]-P[0]), Math.abs(Q[1]-P[1])) * 180 / Math.PI;
}

// ---------------- HANDSTAND ----------------
const W_SHO = 0.8, W_HIP = 0.9, W_KNE = 0.4, W_LEAN = 1.2;

// tie-break identical to Python's max() on (value, string): value desc, then string desc
const worstFault = arr => arr.sort((a, b) => (b[0] - a[0]) || (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))[0];

export function handstandScore(wri, sho, hip, kne, ank) {
  const shoA = angleAt(wri, sho, hip);
  const hipA = angleAt(sho, hip, kne);
  const kneA = angleAt(hip, kne, ank);
  const lean = leanFromVertical(wri, hip);
  // deadzone: a few degrees of tolerance (noise + human margin) so a near-perfect line reads ~100.
  const dSho = Math.max(0, (180 - shoA) - 3);
  const dHip = Math.max(0, (180 - hipA) - 3);
  const dKne = Math.max(0, (180 - kneA) - 4);
  const dLean = Math.max(0, lean - 2);
  let score = 100 - W_SHO*dSho - W_HIP*dHip - W_KNE*dKne - W_LEAN*dLean;
  score = Math.max(0, Math.min(100, score));
  // a big fold at the hip is a pike (legs forward); a subtle arch is a banana (ribs flared)
  const hipCue = (180 - hipA) > 40 ? "open the pike — bring your legs over" : "ribs in — kill the banana";
  const faults = worstFault([
    [dSho*W_SHO, "open your shoulders"],
    [dHip*W_HIP, hipCue],
    [dKne*W_KNE, "squeeze your legs straight"],
    [dLean*W_LEAN, "stack over your wrists"],
  ]);
  const cue = score >= 90 ? "locked in — hold it" : faults[1];
  return { score, shoulder: shoA, hip: hipA, knee: kneA, lean, cue };
}

// STRADDLE handstand: legs are deliberately apart, so ignore leg/knee straightness
// and score only the shoulders + the stack (hips over wrists). Same weights + deadzone.
export function straddleHandstandScore(wri, sho, hip, kne, ank) {
  const shoA = angleAt(wri, sho, hip);
  const lean = leanFromVertical(wri, hip);
  const dSho = Math.max(0, (180 - shoA) - 3);
  const dLean = Math.max(0, lean - 2);
  let score = 100 - W_SHO * dSho - W_LEAN * dLean;
  score = Math.max(0, Math.min(100, score));
  const faults = worstFault([
    [dSho * W_SHO, "open your shoulders"],
    [dLean * W_LEAN, "stack hips over your wrists"],
  ]);
  const cue = score >= 90 ? "clean straddle — hold it" : faults[1];
  return { score, shoulder: shoA, lean, cue };
}

// STACK handstand: the strict, stack-focused variant. Takes the full handstand score
// and adds an extra penalty on the lean, so the cue drives you to stack tight.
export function stackHandstandScore(wri, sho, hip, kne, ank) {
  const r = handstandScore(wri, sho, hip, kne, ank);
  const score = Math.max(0, Math.min(100, r.score - 0.8 * r.lean));
  const cue = score >= 92 ? "stacked and locked" : (r.lean > 6 ? "stack tighter over your wrists" : r.cue);
  return { ...r, score, cue };
}

export function isInverted(wri, sho, hip, ank) {
  return wri[1] > hip[1] && ank[1] < sho[1];       // y down: wrists low, ankles high
}

// ---------------- PUSH-UP ----------------
export const TOP_A = 155, BOT_A = 95;

export function pushupFrame(sho, elb, wri, hip, ank) {
  const elbow = angleAt(sho, elb, wri);
  const line = angleAt(sho, hip, ank);
  const vx = ank[0]-sho[0], vy = ank[1]-sho[1], wx = hip[0]-sho[0], wy = hip[1]-sho[1];
  const sag = (vx*wy - vy*wx) > 0;
  return { elbow, lineDev: 180-line, sag };
}

export function depthScore(minElbow) {
  if (minElbow <= 90) return 100;
  if (minElbow >= 130) return 0;
  return (130 - minElbow) / 40 * 100;
}
export function lineScore(meanDev) { return Math.max(0, 100 - 5*meanDev); }

export function rateRep(minElbow, meanLineDev, topElbow) {
  const d = depthScore(minElbow), l = lineScore(meanLineDev);
  const lock = topElbow >= 165 ? 100 : 50;
  const score = 0.5*d + 0.4*l + 0.1*lock;
  let cue;
  if (d < 60) cue = "go deeper — chest to the floor";
  else if (l < 60) cue = "hips sagging — squeeze your glutes";
  else if (lock < 100) cue = "finish the lockout";
  else cue = "clean rep";
  return { score, depth: d, line: l, cue };
}

export class RepCounter {
  constructor() { this.state = "TOP"; this.minElbow = 180; this.devs = []; this.reps = []; }
  feed(elbow, lineDev) {
    if (this.state === "TOP") {
      if (elbow < TOP_A) { this.state = "DOWN"; this.minElbow = elbow; this.devs = [lineDev]; }
    } else if (this.state === "DOWN") {
      this.minElbow = Math.min(this.minElbow, elbow); this.devs.push(lineDev);
      if (elbow > this.minElbow + 15) this.state = "UP";
    } else if (this.state === "UP") {
      this.devs.push(lineDev);
      if (elbow >= TOP_A) {
        const mean = this.devs.reduce((a, b) => a+b, 0) / this.devs.length;
        this.reps.push(rateRep(this.minElbow, mean, elbow));
        this.state = "TOP";
      }
    }
  }
}

// ---------------- side-picking + smoothing helpers (used by the app) ----------
export function pickSide(lm) {
  // choose the side whose chain is more visible; lm = 33 landmarks {x,y,visibility}
  const L = [11,13,15,23,25,27], R = [12,14,16,24,26,28];
  const vis = idx => idx.reduce((a, i) => a + (lm[i].visibility ?? 0), 0);
  return vis(L) >= vis(R) ? "L" : "R";
}
export function chain(lm, side) {
  const m = side === "L"
    ? { sho:11, elb:13, wri:15, hip:23, kne:25, ank:27 }
    : { sho:12, elb:14, wri:16, hip:24, kne:26, ank:28 };
  const P = k => [lm[m[k]].x, lm[m[k]].y];
  const minVis = Math.min(...Object.values(m).map(i => lm[i].visibility ?? 0));
  return { wri:P("wri"), elb:P("elb"), sho:P("sho"), hip:P("hip"), kne:P("kne"), ank:P("ank"), minVis };
}
export class EMA {
  constructor(a) { this.a = a; this.v = null; }
  feed(x) { this.v = this.v === null ? x : this.a*x + (1-this.a)*this.v; return this.v; }
}

// ---------------- SQUAT ----------------
export const SQ_TOP = 160, SQ_BOT = 100;

export function squatDepthScore(minKnee) {
  if (minKnee <= 90) return 100;
  if (minKnee >= 130) return 0;
  return (130 - minKnee) / 40 * 100;
}
export function squatTorsoScore(meanTorsoLean) { return Math.max(0, 100 - 2.5 * Math.max(0, meanTorsoLean - 20)); }

export function rateSquat(minKnee, meanTorsoLean, topKnee) {
  const d = squatDepthScore(minKnee), t = squatTorsoScore(meanTorsoLean);
  const lock = topKnee >= 155 ? 100 : 50;
  const score = 0.55*d + 0.35*t + 0.10*lock;
  let cue;
  if (d < 60) cue = "sit deeper — hip crease to the knee";
  else if (t < 60) cue = "chest up — you're folding forward";
  else if (lock < 100) cue = "stand all the way up";
  else cue = "clean squat";
  return { score, depth: d, torso: t, cue };
}

export class SquatCounter {
  constructor() { this.state = "TOP"; this.minKnee = 180; this.leans = []; this.reps = []; }
  feed(knee, torsoLean) {
    if (this.state === "TOP") {
      if (knee < SQ_TOP) { this.state = "DOWN"; this.minKnee = knee; this.leans = [torsoLean]; }
    } else if (this.state === "DOWN") {
      this.minKnee = Math.min(this.minKnee, knee); this.leans.push(torsoLean);
      if (knee > this.minKnee + 15) this.state = "UP";
    } else {
      this.leans.push(torsoLean);
      if (knee >= SQ_TOP) {
        const mean = this.leans.reduce((a, b) => a+b, 0) / this.leans.length;
        this.reps.push(rateSquat(this.minKnee, mean, knee));
        this.state = "TOP";
      }
    }
  }
}

// ---------------- PLANK ----------------
export function plankScore(meanLineDev) { return Math.max(0, Math.min(100, 100 - 4*meanLineDev)); }

// ---------------- PULL-UP ----------------
export const PL_TOP = 160, PL_BOT = 90;

export function pullupRomScore(minElbow) {
  if (minElbow <= 60) return 100;
  if (minElbow >= 110) return 0;
  return (110 - minElbow) / 50 * 100;
}
export function ratePullup(minElbow) {
  const r = pullupRomScore(minElbow);
  return { score: r, rom: r, cue: r < 60 ? "pull higher — chin over the bar" : "clean pull-up" };
}
export class PullupCounter {
  constructor() { this.state = "HANG"; this.minElbow = 180; this.reps = []; }
  feed(elbow) {
    if (this.state === "HANG") {
      if (elbow < PL_TOP) { this.state = "PULL"; this.minElbow = elbow; }
    } else if (this.state === "PULL") {
      this.minElbow = Math.min(this.minElbow, elbow);
      if (elbow > this.minElbow + 15) this.state = "LOWER";
    } else if (elbow >= PL_TOP) {
      this.reps.push(ratePullup(this.minElbow));
      this.state = "HANG";
    }
  }
}

// posture helpers for the new modes
export function isHanging(wri, sho, hip) { return wri[1] < sho[1] && sho[1] < hip[1]; }  // wrists above shoulders above hips
export function torsoLean(sho, hip) { return leanFromVertical(hip, sho); }               // torso vs vertical (squat fault)

// ---------------- SKILL + MOBILITY HOLDS ----------------
export function frontLeverScore(sho, hip, kne, ank) {
  const hipA = angleAt(sho, hip, kne);
  const kneA = angleAt(hip, kne, ank);
  const horiz = Math.atan2(Math.abs(ank[1]-sho[1]), Math.abs(ank[0]-sho[0])) * 180 / Math.PI;
  const score = Math.max(0, Math.min(100, 100 - 1.2*(180-hipA) - 1.0*horiz - 0.4*(180-kneA)));
  const faults = [
    [(180-hipA)*1.2, "kill the pike — open your hips"],
    [horiz*1.0, "lift — you're dropping off horizontal"],
    [(180-kneA)*0.4, "squeeze your legs straight"],
  ].sort((a, b) => b[0]-a[0]);
  return { score, hip: hipA, horiz, knee: kneA, cue: score >= 90 ? "textbook lever — hold" : faults[0][1] };
}

export function lsitScore(hip, kne, ank) {
  const legAngle = Math.atan2(hip[1]-ank[1], Math.abs(ank[0]-hip[0])) * 180 / Math.PI;
  const kneA = angleAt(hip, kne, ank);
  const score = Math.max(0, Math.min(100, 85 + 1.5*legAngle - 0.4*(180-kneA)));
  let cue;
  if ((180-kneA) > 25) cue = "straighten your knees";
  else if (legAngle < -8) cue = "lift your legs — toes above hip height";
  else if (score >= 95) cue = "that's a V — outstanding";
  else cue = "strong L — press the floor away";
  return { score, legAngle, knee: kneA, cue };
}

export function pikeScore(sho, hip, kne, ank) {
  const fold = angleAt(sho, hip, ank);
  const kneA = angleAt(hip, kne, ank);
  const base = Math.max(0, Math.min(100, (90 - fold) / 55 * 100));
  const score = Math.max(0, base - 1.0*(180-kneA));
  let cue;
  if ((180-kneA) > 15) cue = "knees locked — a bent-knee fold doesn't count";
  else if (score >= 85) cue = "beautiful fold — breathe and sink";
  else cue = "hinge deeper — chest to thighs";
  return { score, fold, knee: kneA, cue };
}

export function bridgeScore(wri, sho, hip, kne) {
  const shoA = angleAt(wri, sho, hip);
  const hipA = angleAt(sho, hip, kne);
  const score = Math.max(0, Math.min(100, 100 - 1.2*(180-shoA) - 0.6*(180-hipA)));
  const faults = [
    [(180-shoA)*1.2, "push your chest over your hands — open the shoulders"],
    [(180-hipA)*0.6, "drive your hips higher"],
  ].sort((a, b) => b[0]-a[0]);
  return { score, shoulder: shoA, hip: hipA, cue: score >= 88 ? "elite arch" : faults[0][1] };
}

const clamp = x => Math.max(0, Math.min(100, x));

// SUPPORT hold (top of a dip / parallettes): arms locked straight, shoulders stacked over the hands.
export function supportHoldScore(C) {
  const elbow = angleAt(C.sho, C.elb, C.wri);
  const lean = leanFromVertical(C.wri, C.sho);        // forearm/arm vertical = shoulders over hands
  const score = clamp(100 - 1.6*(180-elbow) - 1.6*lean);
  const cue = (180-elbow) > 12 ? "lock your elbows out"
            : lean > 10 ? "stack your shoulders over your hands"
            : "strong support — depress the shoulders and hold";
  return { score, elbow, lean, cue };
}

// DEAD HANG: passive hang, arms straight, body long under the bar.
export function deadHangScore(C) {
  const elbow = angleAt(C.sho, C.elb, C.wri);
  const bodyLean = leanFromVertical(C.sho, C.hip);
  const score = clamp(100 - 1.3*(180-elbow) - 1.0*bodyLean);
  const cue = (180-elbow) > 15 ? "relax — hang with straight arms"
            : bodyLean > 12 ? "still the swing — hang long" : "solid hang — breathe and relax";
  return { score, elbow, cue };
}

// DEEP SQUAT hold (mobility): sit at the bottom, hips below the knees, chest tall.
export function deepSquatScore(C) {
  const knee = angleAt(C.hip, C.kne, C.ank);
  const lean = torsoLean(C.sho, C.hip);
  const depth = clamp((130 - knee) / 65 * 100);       // deeper knee bend = better
  const score = clamp(depth - 1.4 * Math.max(0, lean - 15));
  const cue = knee > 110 ? "sink deeper — hips below the knees"
            : lean > 28 ? "chest tall — stop folding forward" : "great depth — relax into the hole";
  return { score, knee, lean, depth, cue };
}

// posture predicates on a chain C (shared by app + engine so detection can't drift)
export function isFrontLeverPose(C) {
  return C.wri[1] < C.sho[1] - 0.04 && Math.abs(C.sho[1]-C.ank[1]) < 0.15 && Math.abs(C.sho[0]-C.ank[0]) > 0.15;
}
export function isBridgePose(C) {
  // hip = the APEX (face-up arch): well above shoulders AND ankles. A plank's hip sits ON
  // the line, and a deep PIKE FOLD puts shoulders below hips too — so also require the
  // hands roughly UNDER the shoulders (a pike reaches forward toward the feet). [corpus fix]
  return C.hip[1] < C.sho[1] - 0.03 && C.hip[1] < C.ank[1] - 0.10 && C.wri[1] > C.sho[1]
      && Math.abs(C.wri[0] - C.sho[0]) < 0.15
      && angleAt(C.hip, C.kne, C.ank) < 150;   // bent knees: the 2D discriminator vs a standing fold [corpus]
}
export function isPikePose(C) {
  const fold = angleAt(C.sho, C.hip, C.ank);
  const seated = Math.abs(C.ank[1]-C.hip[1]) < 0.14 && Math.abs(C.ank[0]-C.hip[0]) > 0.15;
  // standing forward fold: ankles well below hips, legs STRAIGHT, hands hanging below shoulders
  const standing = (C.ank[1]-C.hip[1]) > 0.15 && angleAt(C.hip, C.kne, C.ank) > 150 && C.wri[1] > C.sho[1] - 0.02;
  // fold < 80 (a real chest-to-thigh hinge), not < 95: upright sitting legs-out is ~90 and must NOT
  // read as a pike fold. [fix, same class as the L-sit floor bug]
  return fold < 80 && (seated || standing);
}
export function isLsitPose(C) {
  const legAngleAbs = Math.abs(Math.atan2(C.hip[1]-C.ank[1], Math.abs(C.ank[0]-C.hip[0])) * 180 / Math.PI);
  // MUST be SUPPORTED: the hands press below the hips (hips lifted off the floor), not just
  // sitting. Sitting on the floor has hands roughly level with the hips (wri ~ hip), so it fails
  // this gate. This kills the "sitting on the floor reads as an L-sit" false positive. [fix]
  return torsoLean(C.sho, C.hip) < 25
      && C.wri[1] > C.hip[1] + 0.05 && C.wri[1] > C.sho[1]   // hands below hips (supported) + below shoulders
      && legAngleAbs < 25 && Math.abs(C.ank[0]-C.hip[0]) > 0.12 && C.ank[1] < C.hip[1] + 0.08;
}
