// The mode/session state machine — camera-agnostic, pure TS, fully headless-testable
// (test/engine.test.mjs). Feed 33 MediaPipe-order landmarks per frame; it returns
// what the UI shows and logs finished holds/sets. [Maker Ollie delivery]
//
// MOVEMENTS (all scorers verified vs the Python reference — see scorer.ts):
//   HANDSTAND  inverted posture  -> alignment score + cue + hold timer
//   PULL-UP    hanging posture   -> rep counting + ROM rating
//   PUSH-UP    horizontal + elbow cycling -> rep counting + depth/line/lockout
//   PLANK      horizontal + arms static  -> hold timer + body-line score
//   SQUAT      standing + knee cycling   -> rep counting + depth/torso/lockout
// Priority: inverted > hanging > horizontal > standing.
import { handstandScore, isInverted, isHanging, pushupFrame, plankScore, torsoLean,
         RepCounter, SquatCounter, PullupCounter, angleAt, pickSide, chain, EMA,
         type Landmark, type HandstandResult } from "./scorer.ts";

export interface CoachFrameOut {
  mode: "READY" | "IN FRAME" | "HANDSTAND" | "PUSH-UP" | "PLANK" | "SQUAT" | "PULL-UP";
  score: number | null;
  cue: string | null;
  holdSecs: number | null;
  reps: number | null;
}
export type SessionEntry =
  | { type: "handstand"; secs: number; avg: number; min: number; at: string }
  | { type: "plank"; secs: number; avg: number; at: string }
  | { type: "pushups" | "squats" | "pullups"; reps: number; avg: number; scores: number[]; at: string };

const VIS_GATE = 0.4, HORIZ_BAND = 0.28;
const HOLD_START_MS = 500, HOLD_END_MS = 700, SET_END_MS = 3000, MIN_HOLD_S = 1.5;
const PLANK_ARM_MS = 2500, PLANK_STILL_ELBOW = 150;

const round1 = (x: number) => Math.round(x * 10) / 10;

export class CoachEngine {
  session: SessionEntry[] = [];
  onLog?: (e: SessionEntry) => void;             // wire to the supabase insert
  private scoreEMA = new EMA(0.25);
  private hs = { active: false, t0: 0, sum: 0, n: 0, min: 100, lastInv: 0, pend: 0 };
  private pu = { counter: new RepCounter(), lastActive: 0, lastCue: null as string | null, lastScore: null as number | null };
  private pk = { active: false, t0: 0, devSum: 0, n: 0, horizSince: 0, moved: false, lastHoriz: 0 };
  private sq = { counter: new SquatCounter(), lastRepAt: 0 };
  private pl = { counter: new PullupCounter(), lastHang: 0 };

  feed(lm: Landmark[] | null, now: number): CoachFrameOut {
    if (!lm) return this.tickIdle(now, "READY");
    const C = chain(lm, pickSide(lm));
    const visible = C.minVis > VIS_GATE;
    if (!visible) return this.tickIdle(now, "READY");

    const inv = isInverted(C.wri, C.sho, C.hip, C.ank);
    const hang = !inv && isHanging(C.wri, C.sho, C.hip);
    const horiz = !inv && !hang && Math.abs(C.sho[1] - C.ank[1]) < HORIZ_BAND && C.wri[1] > C.sho[1] - 0.05;
    const standing = !inv && !hang && !horiz;

    // ---------- HANDSTAND (top priority) ----------
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
          avg: round1(this.hs.sum / Math.max(1, this.hs.n)), min: round1(this.hs.min), at: new Date().toISOString() });
        this.hs.active = false;
        return this.tickIdle(now, "IN FRAME");
      }
      return { mode: "HANDSTAND", score: this.scoreEMA.v, cue: null, holdSecs: (now - this.hs.t0) / 1000, reps: null };
    }

    // ---------- PULL-UP (hanging) ----------
    if (hang) {
      this.pl.lastHang = now;
      const elbow = angleAt(C.sho, C.elb, C.wri);
      this.pl.counter.feed(elbow);
      const reps = this.pl.counter.reps;
      const last = reps[reps.length - 1];
      return { mode: "PULL-UP", score: last ? last.score : null, cue: last ? last.cue : null,
               holdSecs: null, reps: reps.length };
    }
    if (this.pl.counter.reps.length && now - this.pl.lastHang > SET_END_MS) this.closePullups();

    // ---------- HORIZONTAL: push-up vs plank ----------
    if (horiz) {
      if (!this.pk.horizSince) { this.pk.horizSince = now; this.pk.moved = false; }
      this.pk.lastHoriz = now;
      this.pu.lastActive = now;
      const f = pushupFrame(C.sho, C.elb, C.wri, C.hip, C.ank);
      this.pu.counter.feed(f.elbow, f.lineDev);
      if (f.elbow < PLANK_STILL_ELBOW) this.pk.moved = true;    // arms bending = not a plank

      const reps = this.pu.counter.reps;
      if (reps.length) {                                        // it's a push-up set
        if (this.pk.active) this.pk.active = false;             // cancel any provisional plank
        const last = reps[reps.length - 1];
        this.pu.lastScore = last.score; this.pu.lastCue = last.cue;
        return { mode: "PUSH-UP", score: last.score, cue: last.cue, holdSecs: null, reps: reps.length };
      }
      // no reps yet: plank arms if we've been horizontal + still long enough
      if (!this.pk.moved && now - this.pk.horizSince > PLANK_ARM_MS) {
        if (!this.pk.active) { this.pk.active = true; this.pk.t0 = this.pk.horizSince; this.pk.devSum = 0; this.pk.n = 0; }
        this.pk.devSum += Math.abs(f.lineDev); this.pk.n++;
        const s = plankScore(this.pk.devSum / this.pk.n);
        return { mode: "PLANK", score: s, cue: s < 65 ? "straight line — squeeze glutes, ribs in" : "strong line — hold",
                 holdSecs: (now - this.pk.t0) / 1000, reps: null };
      }
      return { mode: "PUSH-UP", score: this.pu.lastScore, cue: this.pu.lastCue, holdSecs: null, reps: reps.length };
    }
    // left horizontal: close plank (debounced) or push-up set (idle)
    if (this.pk.active && now - this.pk.lastHoriz > HOLD_END_MS) this.closePlank();
    if (this.pu.counter.reps.length && now - this.pu.lastActive > SET_END_MS) this.closePushups();

    // ---------- SQUAT (standing) ----------
    if (standing) {
      const knee = angleAt(C.hip, C.kne, C.ank);
      const before = this.sq.counter.reps.length;
      this.sq.counter.feed(knee, torsoLean(C.sho, C.hip));
      const reps = this.sq.counter.reps;
      if (reps.length > before) this.sq.lastRepAt = now;
      if (this.sq.counter.state !== "TOP" || reps.length) {
        if (reps.length && now - this.sq.lastRepAt > SET_END_MS + 1000 && this.sq.counter.state === "TOP") {
          this.closeSquats();
          return this.tickIdle(now, "IN FRAME");
        }
        const last = reps[reps.length - 1];
        return { mode: "SQUAT", score: last ? last.score : null, cue: last ? last.cue : null,
                 holdSecs: null, reps: reps.length };
      }
    }
    return this.tickIdle(now, "IN FRAME");
  }

  // ---------- set/hold closers ----------
  private closePushups() {
    const reps = this.pu.counter.reps;
    this.log({ type: "pushups", reps: reps.length, avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map(r => Math.round(r.score)), at: new Date().toISOString() });
    this.pu.counter = new RepCounter(); this.pu.lastScore = null; this.pu.lastCue = null;
    this.pk.horizSince = 0;
  }
  private closePlank() {
    const secs = (this.pk.lastHoriz - this.pk.t0) / 1000;
    if (secs > MIN_HOLD_S && this.pk.n > 0)
      this.log({ type: "plank", secs: round1(secs), avg: round1(plankScore(this.pk.devSum / this.pk.n)), at: new Date().toISOString() });
    this.pk.active = false; this.pk.horizSince = 0;
  }
  private closeSquats() {
    const reps = this.sq.counter.reps;
    this.log({ type: "squats", reps: reps.length, avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map(r => Math.round(r.score)), at: new Date().toISOString() });
    this.sq.counter = new SquatCounter();
  }
  private closePullups() {
    const reps = this.pl.counter.reps;
    this.log({ type: "pullups", reps: reps.length, avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map(r => Math.round(r.score)), at: new Date().toISOString() });
    this.pl.counter = new PullupCounter();
  }
  private tickIdle(now: number, mode: "READY" | "IN FRAME"): CoachFrameOut {
    if (this.pk.active && now - this.pk.lastHoriz > HOLD_END_MS) this.closePlank();
    else if (!this.pk.active && this.pk.horizSince && now - this.pk.lastHoriz > HOLD_END_MS) this.pk.horizSince = 0;
    if (this.pu.counter.reps.length && now - this.pu.lastActive > SET_END_MS) this.closePushups();
    if (this.pl.counter.reps.length && now - this.pl.lastHang > SET_END_MS) this.closePullups();
    if (this.sq.counter.reps.length && now - this.sq.lastRepAt > SET_END_MS + 1000) this.closeSquats();
    return { mode, score: null, cue: null, holdSecs: null, reps: null };
  }
  private log(e: SessionEntry) { this.session.push(e); this.onLog?.(e); }
}

/* Supabase wiring:
   engine.onLog = async (e) => supabase.from("coach_sessions").insert({
     member_id: user.id,
     kind: e.type === "handstand" ? "handstand" : e.type,
     secs: "secs" in e ? e.secs : null,
     avg_score: e.avg,
     min_score: e.type === "handstand" ? e.min : null,
     reps: "scores" in e ? e.scores.map(s => ({ score: s })) : null,
     source: "camera", device: "app",
   });
*/
