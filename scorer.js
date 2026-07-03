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

export function handstandScore(wri, sho, hip, kne, ank) {
  const shoA = angleAt(wri, sho, hip);
  const hipA = angleAt(sho, hip, kne);
  const kneA = angleAt(hip, kne, ank);
  const lean = leanFromVertical(wri, hip);
  const dSho = 180-shoA, dHip = 180-hipA, dKne = 180-kneA;
  let score = 100 - W_SHO*dSho - W_HIP*dHip - W_KNE*dKne - W_LEAN*lean;
  score = Math.max(0, Math.min(100, score));
  const faults = [
    [dSho*W_SHO, "open your shoulders"],
    [dHip*W_HIP, "ribs in — kill the banana"],
    [dKne*W_KNE, "squeeze your legs straight"],
    [lean*W_LEAN, "stack over your wrists"],
  ].sort((a, b) => b[0]-a[0]);
  const cue = score >= 90 ? "locked in — hold it" : faults[0][1];
  return { score, shoulder: shoA, hip: hipA, knee: kneA, lean, cue };
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
