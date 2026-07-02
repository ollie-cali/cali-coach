// The mode/session state machine — the SAME logic as the web demo's loop, extracted
// into a pure, camera-agnostic hook-friendly class. Feed it landmarks each frame
// (from ANY pose source), it returns what the UI should show and logs sessions.
// [Maker Ollie delivery] Pure TS: usable in a hook, a worklet callback, or tests.
import { handstandScore, isInverted, pushupFrame, RepCounter, pickSide, chain, EMA,
         type Landmark, type HandstandResult, type RepResult } from "./scorer.ts";

export interface CoachFrameOut {
  mode: "READY" | "IN FRAME" | "HANDSTAND" | "PUSH-UP";
  score: number | null;          // smoothed display score
  cue: string | null;
  holdSecs: number | null;
  reps: number | null;
}
export type SessionEntry =
  | { type: "handstand"; secs: number; avg: number; min: number; at: string }
  | { type: "pushups"; reps: number; avg: number; scores: number[]; at: string };

const VIS_GATE = 0.4, HORIZ_BAND = 0.28;
const HOLD_START_MS = 500, HOLD_END_MS = 700, SET_END_MS = 3000, MIN_HOLD_S = 1.5;

export class CoachEngine {
  session: SessionEntry[] = [];
  onLog?: (e: SessionEntry) => void;             // wire this to the supabase insert
  private scoreEMA = new EMA(0.25);
  private hs = { active: false, t0: 0, sum: 0, n: 0, min: 100, lastInv: 0, pend: 0 };
  private pu = { counter: new RepCounter(), lastActive: 0 };
  private lastRep: RepResult | null = null;

  /** Call once per frame with 33 MediaPipe-order landmarks + a ms timestamp. */
  feed(lm: Landmark[] | null, now: number): CoachFrameOut {
    if (!lm) return this.idle(now, "READY");
    const C = chain(lm, pickSide(lm));
    const visible = C.minVis > VIS_GATE;
    const inv = visible && isInverted(C.wri, C.sho, C.hip, C.ank);
    const horiz = visible && !inv && Math.abs(C.sho[1] - C.ank[1]) < HORIZ_BAND && C.wri[1] > C.sho[1] - 0.05;

    // ---- handstand ----
    if (inv) {
      this.hs.lastInv = now;
      if (!this.hs.active) {
        if (!this.hs.pend) this.hs.pend = now;
        if (now - this.hs.pend > HOLD_START_MS) {
          this.hs.active = true; this.hs.t0 = now; this.hs.sum = 0; this.hs.n = 0; this.hs.min = 100;
          this.scoreEMA.v = null;
        }
      }
    } else this.hs.pend = 0;

    if (this.hs.active) {
      if (inv) {
        const r: HandstandResult = handstandScore(C.wri, C.sho, C.hip, C.kne, C.ank);
        const s = this.scoreEMA.feed(r.score);
        this.hs.sum += r.score; this.hs.n++; this.hs.min = Math.min(this.hs.min, r.score);
        return { mode: "HANDSTAND", score: s, cue: r.cue, holdSecs: (now - this.hs.t0) / 1000, reps: null };
      }
      if (now - this.hs.lastInv > HOLD_END_MS) {
        const secs = (this.hs.lastInv - this.hs.t0) / 1000;
        if (secs > MIN_HOLD_S) this.log({ type: "handstand", secs: round1(secs),
          avg: round1(this.hs.sum / Math.max(1, this.hs.n)), min: round1(this.hs.min),
          at: new Date().toISOString() });
        this.hs.active = false;
        return this.idle(now, "IN FRAME");
      }
      return { mode: "HANDSTAND", score: this.scoreEMA.v, cue: null, holdSecs: (now - this.hs.t0) / 1000, reps: null };
    }

    // ---- push-up ----
    if (horiz) {
      this.pu.lastActive = now;
      const f = pushupFrame(C.sho, C.elb, C.wri, C.hip, C.ank);
      this.pu.counter.feed(f.elbow, f.lineDev);
      const reps = this.pu.counter.reps;
      if (reps.length) this.lastRep = reps[reps.length - 1];
      return { mode: "PUSH-UP", score: this.lastRep?.score ?? null,
               cue: this.lastRep?.cue ?? null, holdSecs: null, reps: reps.length };
    }

    // ---- idle: close an open set ----
    if (this.pu.counter.reps.length && now - this.pu.lastActive > SET_END_MS) {
      const reps = this.pu.counter.reps;
      this.log({ type: "pushups", reps: reps.length,
        avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
        scores: reps.map(r => Math.round(r.score)), at: new Date().toISOString() });
      this.pu.counter = new RepCounter(); this.lastRep = null;
    }
    return this.idle(now, visible ? "IN FRAME" : "READY");
  }

  private idle(now: number, mode: "READY" | "IN FRAME"): CoachFrameOut {
    return { mode, score: null, cue: null, holdSecs: null, reps: null };
  }
  private log(e: SessionEntry) { this.session.push(e); this.onLog?.(e); }
}
const round1 = (x: number) => Math.round(x * 10) / 10;

/* Supabase wiring (in the app):
   engine.onLog = async (e) => supabase.from("coach_sessions").insert({
     member_id: user.id,
     kind: e.type === "handstand" ? "handstand" : "pushups",
     secs: e.type === "handstand" ? e.secs : null,
     avg_score: e.avg,
     min_score: e.type === "handstand" ? e.min : null,
     reps: e.type === "pushups" ? e.scores.map(s => ({ score: s })) : null,
     source: "camera", device: "app",
   });
*/
