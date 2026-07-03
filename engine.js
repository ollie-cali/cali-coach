import {
  handstandScore,
  isInverted,
  isHanging,
  pushupFrame,
  plankScore,
  torsoLean,
  frontLeverScore,
  lsitScore,
  pikeScore,
  bridgeScore,
  isFrontLeverPose,
  isBridgePose,
  isPikePose,
  isLsitPose,
  RepCounter,
  SquatCounter,
  PullupCounter,
  angleAt,
  pickSide,
  chain,
  EMA
} from "./scorer.js";
const VIS_GATE = 0.4, HORIZ_BAND = 0.28;
const HOLD_START_MS = 500, HOLD_END_MS = 700, SET_END_MS = 3e3, MIN_HOLD_S = 1.5;
const PLANK_ARM_MS = 2500, PLANK_STILL_ELBOW = 150;
const round1 = (x) => Math.round(x * 10) / 10;
class CoachEngine {
  session = [];
  onLog;
  // wire to the supabase insert
  locked = null;
  // declared-movement mode (coach/workout flow)
  /** Lock detection to one movement (null = auto-detect all nine). */
  lock(kind) {
    this.locked = kind;
  }
  scoreEMA = new EMA(0.25);
  hs = { active: false, t0: 0, sum: 0, n: 0, min: 100, lastInv: 0, pend: 0 };
  pu = { counter: new RepCounter(), lastActive: 0, lastCue: null, lastScore: null };
  pk = { active: false, t0: 0, devSum: 0, n: 0, horizSince: 0, moved: false, lastHoriz: 0 };
  sq = { counter: new SquatCounter(), lastRepAt: 0 };
  pl = { counter: new PullupCounter(), lastHang: 0 };
  holds = {
    front_lever: new HoldTracker("front_lever"),
    lsit: new HoldTracker("lsit"),
    pike: new HoldTracker("pike"),
    bridge: new HoldTracker("bridge")
  };
  hold(kind, mode, now, r) {
    const h = this.holds[kind];
    const out = h.feed(now, r.score);
    if (out.secs !== null) return { mode, score: out.score, cue: r.cue, holdSecs: out.secs, reps: null };
    return { mode, score: null, cue: null, holdSecs: null, reps: null };
  }
  feed(lm, now) {
    if (!lm) return this.tickIdle(now, "READY");
    const C = chain(lm, pickSide(lm));
    const visible = C.minVis > VIS_GATE;
    if (!visible) return this.tickIdle(now, "READY");
    const inv = isInverted(C.wri, C.sho, C.hip, C.ank);
    const lever = !inv && isFrontLeverPose(C);
    const hang = !inv && !lever && isHanging(C.wri, C.sho, C.hip);
    const lsitEarly = !inv && !lever && !hang && isLsitPose(C);
    const pikeEarly = !inv && !lever && !hang && !lsitEarly && isPikePose(C);
    const bridge = !inv && !lever && !hang && !lsitEarly && !pikeEarly && isBridgePose(C);
    let pikeP = pikeEarly;
    let lsitP = lsitEarly;
    let horiz = !inv && !lever && !hang && !bridge && !pikeP && !lsitP && Math.abs(C.sho[1] - C.ank[1]) < HORIZ_BAND && C.wri[1] > C.sho[1] - 0.05;
    let standing = !inv && !lever && !hang && !bridge && !horiz && !pikeP && !lsitP;
    let invA = inv, leverA = lever, hangA = hang, bridgeA = bridge;
    if (this.locked) {
      const want = this.locked;
      invA = want === "handstand" ? inv : false;
      leverA = want === "front_lever" ? lever : false;
      hangA = want === "pullups" ? hang : false;
      bridgeA = want === "bridge" ? bridge : false;
      pikeP = want === "pike" ? pikeP : false;
      lsitP = want === "lsit" ? lsitP : false;
      horiz = want === "pushups" || want === "plank" ? !inv && !hang && Math.abs(C.sho[1] - C.ank[1]) < HORIZ_BAND && C.wri[1] > C.sho[1] - 0.05 : false;
      standing = want === "squats" ? !inv && !hang : false;
      if (want === "plank") this.pk.moved = false;
      if (want === "pushups") this.pk.horizSince = 0;
    }
    if (invA) {
      this.hs.lastInv = now;
      if (!this.hs.active) {
        if (!this.hs.pend) this.hs.pend = now;
        if (now - this.hs.pend > HOLD_START_MS) {
          this.hs.active = true;
          this.hs.t0 = now;
          this.hs.sum = 0;
          this.hs.n = 0;
          this.hs.min = 100;
          this.scoreEMA.v = null;
        }
      }
    } else this.hs.pend = 0;
    if (this.hs.active) {
      if (invA) {
        const r = handstandScore(C.wri, C.sho, C.hip, C.kne, C.ank);
        const s = this.scoreEMA.feed(r.score);
        this.hs.sum += r.score;
        this.hs.n++;
        this.hs.min = Math.min(this.hs.min, r.score);
        return { mode: "HANDSTAND", score: s, cue: r.cue, holdSecs: (now - this.hs.t0) / 1e3, reps: null };
      }
      if (now - this.hs.lastInv > HOLD_END_MS) {
        const secs = (this.hs.lastInv - this.hs.t0) / 1e3;
        if (secs > MIN_HOLD_S) this.log({
          type: "handstand",
          secs: round1(secs),
          avg: round1(this.hs.sum / Math.max(1, this.hs.n)),
          min: round1(this.hs.min),
          at: (/* @__PURE__ */ new Date()).toISOString()
        });
        this.hs.active = false;
        return this.tickIdle(now, "IN FRAME");
      }
      return { mode: "HANDSTAND", score: this.scoreEMA.v, cue: null, holdSecs: (now - this.hs.t0) / 1e3, reps: null };
    }
    if (leverA) return this.hold("front_lever", "FRONT LEVER", now, frontLeverScore(C.sho, C.hip, C.kne, C.ank));
    this.holds.front_lever.tick(now, (e) => this.log(e));
    if (bridgeA) return this.hold("bridge", "BRIDGE", now, bridgeScore(C.wri, C.sho, C.hip, C.kne));
    this.holds.bridge.tick(now, (e) => this.log(e));
    if (pikeP) return this.hold("pike", "PIKE", now, pikeScore(C.sho, C.hip, C.kne, C.ank));
    this.holds.pike.tick(now, (e) => this.log(e));
    if (lsitP) return this.hold("lsit", "L-SIT", now, lsitScore(C.hip, C.kne, C.ank));
    this.holds.lsit.tick(now, (e) => this.log(e));
    if (hangA) {
      this.pl.lastHang = now;
      const elbow = angleAt(C.sho, C.elb, C.wri);
      this.pl.counter.feed(elbow);
      const reps = this.pl.counter.reps;
      const last = reps[reps.length - 1];
      return {
        mode: "PULL-UP",
        score: last ? last.score : null,
        cue: last ? last.cue : null,
        holdSecs: null,
        reps: reps.length
      };
    }
    if (this.pl.counter.reps.length && now - this.pl.lastHang > SET_END_MS) this.closePullups();
    if (horiz) {
      if (!this.pk.horizSince) {
        this.pk.horizSince = now;
        this.pk.moved = false;
      }
      this.pk.lastHoriz = now;
      this.pu.lastActive = now;
      const f = pushupFrame(C.sho, C.elb, C.wri, C.hip, C.ank);
      if (this.locked !== "plank") this.pu.counter.feed(f.elbow, f.lineDev);
      if (f.elbow < PLANK_STILL_ELBOW && this.locked !== "plank") this.pk.moved = true;
      const reps = this.pu.counter.reps;
      if (reps.length) {
        if (this.pk.active) this.pk.active = false;
        const last = reps[reps.length - 1];
        this.pu.lastScore = last.score;
        this.pu.lastCue = last.cue;
        return { mode: "PUSH-UP", score: last.score, cue: last.cue, holdSecs: null, reps: reps.length };
      }
      if (!this.pk.moved && now - this.pk.horizSince > PLANK_ARM_MS) {
        if (!this.pk.active) {
          this.pk.active = true;
          this.pk.t0 = this.pk.horizSince;
          this.pk.devSum = 0;
          this.pk.n = 0;
        }
        this.pk.devSum += Math.abs(f.lineDev);
        this.pk.n++;
        const s = plankScore(this.pk.devSum / this.pk.n);
        return {
          mode: "PLANK",
          score: s,
          cue: s < 65 ? "straight line \u2014 squeeze glutes, ribs in" : "strong line \u2014 hold",
          holdSecs: (now - this.pk.t0) / 1e3,
          reps: null
        };
      }
      return { mode: "PUSH-UP", score: this.pu.lastScore, cue: this.pu.lastCue, holdSecs: null, reps: reps.length };
    }
    if (this.pk.active && now - this.pk.lastHoriz > HOLD_END_MS) this.closePlank();
    if (this.pu.counter.reps.length && now - this.pu.lastActive > SET_END_MS) this.closePushups();
    if (standing) {
      const knee = angleAt(C.hip, C.kne, C.ank);
      const before = this.sq.counter.reps.length;
      this.sq.counter.feed(knee, torsoLean(C.sho, C.hip));
      const reps = this.sq.counter.reps;
      if (reps.length > before) this.sq.lastRepAt = now;
      if (this.sq.counter.state !== "TOP" || reps.length) {
        if (reps.length && now - this.sq.lastRepAt > SET_END_MS + 1e3 && this.sq.counter.state === "TOP") {
          this.closeSquats();
          return this.tickIdle(now, "IN FRAME");
        }
        const last = reps[reps.length - 1];
        return {
          mode: "SQUAT",
          score: last ? last.score : null,
          cue: last ? last.cue : null,
          holdSecs: null,
          reps: reps.length
        };
      }
    }
    return this.tickIdle(now, "IN FRAME");
  }
  // ---------- set/hold closers ----------
  closePushups() {
    const reps = this.pu.counter.reps;
    this.log({
      type: "pushups",
      reps: reps.length,
      avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map((r) => Math.round(r.score)),
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.pu.counter = new RepCounter();
    this.pu.lastScore = null;
    this.pu.lastCue = null;
    this.pk.horizSince = 0;
  }
  closePlank() {
    const secs = (this.pk.lastHoriz - this.pk.t0) / 1e3;
    if (secs > MIN_HOLD_S && this.pk.n > 0)
      this.log({ type: "plank", secs: round1(secs), avg: round1(plankScore(this.pk.devSum / this.pk.n)), at: (/* @__PURE__ */ new Date()).toISOString() });
    this.pk.active = false;
    this.pk.horizSince = 0;
  }
  closeSquats() {
    const reps = this.sq.counter.reps;
    this.log({
      type: "squats",
      reps: reps.length,
      avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map((r) => Math.round(r.score)),
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.sq.counter = new SquatCounter();
  }
  closePullups() {
    const reps = this.pl.counter.reps;
    this.log({
      type: "pullups",
      reps: reps.length,
      avg: round1(reps.reduce((a, r) => a + r.score, 0) / reps.length),
      scores: reps.map((r) => Math.round(r.score)),
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.pl.counter = new PullupCounter();
  }
  tickIdle(now, mode) {
    if (this.hs.active && now - this.hs.lastInv > HOLD_END_MS) {
      const secs = (this.hs.lastInv - this.hs.t0) / 1e3;
      if (secs > MIN_HOLD_S) this.log({
        type: "handstand",
        secs: round1(secs),
        avg: round1(this.hs.sum / Math.max(1, this.hs.n)),
        min: round1(this.hs.min),
        at: (/* @__PURE__ */ new Date()).toISOString()
      });
      this.hs.active = false;
      this.hs.pend = 0;
    }
    for (const k of Object.keys(this.holds))
      this.holds[k].tick(now, (e) => this.log(e));
    if (this.pk.active && now - this.pk.lastHoriz > HOLD_END_MS) this.closePlank();
    else if (!this.pk.active && this.pk.horizSince && now - this.pk.lastHoriz > HOLD_END_MS) this.pk.horizSince = 0;
    if (this.pu.counter.reps.length && now - this.pu.lastActive > SET_END_MS) this.closePushups();
    if (this.pl.counter.reps.length && now - this.pl.lastHang > SET_END_MS) this.closePullups();
    if (this.sq.counter.reps.length && now - this.sq.lastRepAt > SET_END_MS + 1e3) this.closeSquats();
    return { mode, score: null, cue: null, holdSecs: null, reps: null };
  }
  log(e) {
    this.session.push(e);
    this.onLog?.(e);
  }
}
const HOLD_ARM_MS = 800;
class HoldTracker {
  kind;
  pend = 0;
  t0 = 0;
  sum = 0;
  n = 0;
  lastSeen = 0;
  active = false;
  constructor(kind) {
    this.kind = kind;
  }
  feed(now, score) {
    this.lastSeen = now;
    if (!this.active) {
      if (!this.pend) this.pend = now;
      if (now - this.pend < HOLD_ARM_MS) return { secs: null, score: null };
      this.active = true;
      this.t0 = this.pend;
      this.sum = 0;
      this.n = 0;
    }
    this.sum += score;
    this.n++;
    return { secs: (now - this.t0) / 1e3, score: this.sum / this.n };
  }
  tick(now, log) {
    if (!this.active) {
      if (this.pend && now - this.lastSeen > HOLD_END_MS) this.pend = 0;
      return;
    }
    if (now - this.lastSeen > HOLD_END_MS) {
      const secs = (this.lastSeen - this.t0) / 1e3;
      if (secs > MIN_HOLD_S && this.n > 0)
        log({ type: this.kind, secs: round1(secs), avg: round1(this.sum / this.n), at: (/* @__PURE__ */ new Date()).toISOString() });
      this.active = false;
      this.pend = 0;
    }
  }
}
export {
  CoachEngine
};
