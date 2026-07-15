// CALI STRETCH — the AI Mobility Coach engine (pure, testable). Same spine as scorer.js:
// side-view pose -> the joint angle that DEFINES each stretch -> live coaching + PNF timing.
// Reuses scorer.js primitives (angleAt/pickSide/chain). New here: the PNF phase engine, per-stretch
// angle definitions + physio ceilings, PB logic, the TWINGE guardrail. Spec: behaviour-lab/private/stretch-app-spec.md
import { angleAt, pickSide, chain } from "./scorer.js";

// ---------------- the stretch library (v1 content from the spec §9) ----------------
// angle: which joint the app measures · dir +1 = bigger-is-better (open), -1 = smaller-is-better (fold)
// ceiling: physio safe cap (knee-loaded); gate: needs physio green-light before it's offered
export const STRETCHES = {
  couch:       { name: "Couch stretch",      side: true,  secs: 300, angle: "hip_ext",     dir: +1, target: 172, ceiling: 165, knee: true,  gate: true,  skills: ["press"],
                 cues: { hip_drop: "tuck the pelvis under — don't arch the back", forward: "ease the hips forward" } },
  frog:        { name: "Frog",                side: false, secs: 600, angle: "hip_abduct",  dir: +1, target: 125,               knee: true,               skills: ["stalder"],
                 cues: { back: "keep the back flat, hips back", wide: "widen the knees a touch" } },
  squat:       { name: "Deep squat hold",     side: true,  secs: 300, angle: "knee_depth",  dir: -1, target: 72,  ceiling: 82,  knee: true,  gate: true,
                 cues: { heels: "heels down, chest tall", depth: "sink the hips a little lower" } },
  open:        { name: "Open slot",           side: true,  secs: 300, angle: "hip_fold",    dir: -1, target: 45 },
  pancake:     { name: "Pancake fold",        side: true,  secs: 600, angle: "hip_fold",    dir: -1, target: 40,               skills: ["stalder", "press"],
                 cues: { tilt: "tilt the pelvis forward, lead with the belly", flat: "long spine, ribs down" } },
  sidesplit:   { name: "Side splits",         side: false, secs: 600, angle: "inter_thigh", dir: +1, target: 172,             skills: [],
                 cues: { rotate: "point the knees up, external rotation", even: "even both sides" } },
  compression: { name: "Compression / pike",  side: true,  secs: 300, angle: "closed_hip",  dir: -1, target: 40,               skills: ["press", "stalder"],
                 cues: { active: "actively pull the thighs to the chest", pike: "close the hip, don't round" } },
};

// default v1 routine order (the spec §9)
export const ROUTINE = ["couch", "frog", "squat", "open", "pancake", "sidesplit"];

// ---------------- the defining angle for a stretch, from 33 MediaPipe landmarks ----------------
export function stretchAngle(lm, key, side) {
  const s = side || pickSide(lm);
  const c = chain(lm, s);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const P = i => [lm[i].x, lm[i].y];
  switch (STRETCHES[key].angle) {
    case "hip_ext":    return angleAt(c.sho, c.hip, c.kne);                 // torso->thigh, opens toward 180 (hip extension)
    case "hip_fold":                                                        // torso folds onto the leg (pancake/open): smaller = deeper
    case "compression":
    case "closed_hip": return angleAt(c.sho, c.hip, c.kne);
    case "knee_depth": return angleAt(c.hip, c.kne, c.ank);                 // squat depth: smaller = deeper
    case "hip_abduct":                                                      // frog: spread between the thighs
    case "inter_thigh": {                                                   // side splits: angle between the two legs -> 180
      const hipMid = mid(P(23), P(24));
      return angleAt(P(25), hipMid, P(26));                                 // knee - hipMid - knee
    }
    default: return angleAt(c.sho, c.hip, c.kne);
  }
}

// visibility of the landmarks a stretch needs (so we only score when framed)
export function stretchReady(lm, key, side) {
  const s = side || pickSide(lm);
  const c = chain(lm, s);
  const front = ["hip_abduct", "inter_thigh"].includes(STRETCHES[key].angle);
  const need = front ? [23, 24, 25, 26] : null;
  const v = need ? need.reduce((a, i) => a + (lm[i].visibility ?? 0), 0) / need.length : c.minVis;
  return v > 0.5;
}

// progress 0..100 toward target (respecting direction), and whether it's a new best
export function stretchProgress(angle, key) {
  const st = STRETCHES[key];
  const start = st.dir > 0 ? 90 : 180;                                      // rough neutral
  const span = Math.abs(st.target - start) || 1;
  const p = st.dir > 0 ? (angle - start) / span : (start - angle) / span;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}
// "better" comparison respecting direction (open = bigger, fold = smaller)
export function isBetter(angle, best, key) {
  if (best == null) return true;
  return STRETCHES[key].dir > 0 ? angle > best : angle < best;
}

// ---------------- the PNF phase engine (the differentiator) ----------------
// contract-relax: SETTLE -> [CONTRACT(iso push) -> RELAX -> DEEPEN] x cycles. Voice+screen per phase.
export class PNFEngine {
  constructor(totalSecs, opts = {}) {
    this.total = totalSecs;
    this.settle = opts.settle ?? 25;
    this.contract = opts.contract ?? 6;
    this.relax = opts.relax ?? 4;
    this.cycles = opts.cycles ?? Math.max(2, Math.floor((totalSecs - (opts.settle ?? 25)) / 45));
    const work = totalSecs - this.settle;
    const per = work / this.cycles;
    this.deepen = Math.max(10, per - this.contract - this.relax);
    this._timeline();
  }
  _timeline() {
    this.segs = [{ phase: "SETTLE", label: "Ease to your end range", cue: "breathe, find the stretch, relax into it", t: this.settle, effort: 0 }];
    for (let i = 0; i < this.cycles; i++) {
      this.segs.push({ phase: "CONTRACT", label: `Push in — 20% · cycle ${i + 1}/${this.cycles}`, cue: "push into the stretch, twenty percent, hold it", t: this.contract, effort: 0.2 });
      this.segs.push({ phase: "RELAX",    label: "Release", cue: "and relax, let go completely", t: this.relax, effort: 0 });
      this.segs.push({ phase: "DEEPEN",   label: "Sink deeper", cue: "now ease deeper into the new range, breathe", t: this.deepen, effort: 0 });
    }
    let acc = 0; this.segs.forEach(s => { s.start = acc; acc += s.t; s.end = acc; });
    this.total = acc;
  }
  at(elapsed) {
    if (elapsed >= this.total) return { done: true, phase: "DONE", label: "Done", cue: "", phaseRemain: 0, seg: null, cycle: this.cycles, cyclesTotal: this.cycles, progress: 100 };
    const seg = this.segs.find(s => elapsed >= s.start && elapsed < s.end) || this.segs[this.segs.length - 1];
    const cyc = this.segs.slice(0, this.segs.indexOf(seg) + 1).filter(s => s.phase === "CONTRACT").length;
    return { done: false, phase: seg.phase, label: seg.label, cue: seg.cue, effort: seg.effort,
             phaseRemain: Math.ceil(seg.end - elapsed), seg, cycle: cyc, cyclesTotal: this.cycles,
             progress: Math.round(elapsed / this.total * 100) };
  }
  // countdown ticks the app speaks during the last 5s of a CONTRACT
  countdown(elapsed) {
    const s = this.at(elapsed);
    if (s.phase === "CONTRACT" && s.phaseRemain <= 5 && s.phaseRemain >= 1) return s.phaseRemain;
    return null;
  }
}

// ---------------- safety guardrail: the knee ceiling + TWINGE ----------------
// returns { safe, warn, capped } given the live angle, the stretch, and any TWINGE-lowered ceiling.
export function guardrail(angle, key, twingeCeiling) {
  const st = STRETCHES[key];
  const ceil = twingeCeiling ?? st.ceiling;
  if (ceil == null) return { safe: true, warn: false, capped: false };
  // "capped" once we're at/over the ceiling in the loading direction
  const over = st.dir > 0 ? angle >= ceil : angle <= ceil;
  const near = st.dir > 0 ? angle >= ceil - 6 : angle <= ceil + 6;
  return { safe: !over, warn: near && !over, capped: over };
}
// one tap: log the twinge, cap tonight, pull the ceiling back to just under where it happened
export function applyTwinge(angle, key) {
  const st = STRETCHES[key];
  if (st.ceiling == null && !st.knee) return null;
  return st.dir > 0 ? Math.min(st.ceiling ?? 999, angle - 4) : Math.max(st.ceiling ?? -999, angle + 4);
}

// skill unlock check: does this best-angle cross the threshold that buys a skill?
export const SKILL_GATES = {
  press:   { compression: 45, pancake: 55 },   // closed-hip + fold ranges needed for press-to-handstand
  stalder: { pancake: 50, sidesplit: 160 },
};
export function skillUnlocks(bests) {
  const out = [];
  for (const [skill, gates] of Object.entries(SKILL_GATES)) {
    const ok = Object.entries(gates).every(([k, thr]) => {
      const b = bests[k]; if (b == null) return false;
      return STRETCHES[k].dir > 0 ? b >= thr : b <= thr;
    });
    if (ok) out.push(skill);
  }
  return out;
}
