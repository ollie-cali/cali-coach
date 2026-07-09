// CALI COACH — the app shell (v5). The tested brain lives in engine.js/scorer.js;
// this file is camera, canvas, feedback, recording, sharing, history, duel, PWA.
import { CoachEngine } from "./engine.js";
import { handstandScore, chain, pickSide, angleAt, torsoLean, isInverted, isHanging,
         isFrontLeverPose, isBridgePose, isPikePose, isLsitPose } from "./scorer.js";
import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const $ = id => document.getElementById(id);
const video = $("video"), canvas = $("canvas"), ctx = canvas.getContext("2d");
let landmarker, facing = "environment", mirrored = false;
const engine = new CoachEngine();
const session = engine.session;
let announced = 0;

// ================= pose engine =================
(async () => {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate: "GPU" },
    runningMode: "VIDEO", numPoses: 1 });
  $("loadmsg").textContent = "pose engine ready";
  $("loadmsg").classList.remove("pulse");
})().catch(e => { $("loadmsg").textContent = "engine failed: " + e.message; });

async function startCam() {
  const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false });
  video.srcObject = s; await video.play();
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const settings = s.getVideoTracks()[0].getSettings();
  mirrored = (settings.facingMode ?? facing) !== "environment";
}
$("start").onclick = async () => {
  try {
    await startCam(); $("splash").remove(); initAudio(); requestTilt(); loop();
    say("Cali Coach ready. Get your whole body in frame, side on.", true);
  } catch (e) { $("loadmsg").textContent = "camera blocked: " + e.message; }
};
$("flip").onclick = async () => {
  const prev = facing;
  facing = facing === "environment" ? "user" : "environment";
  try { video.srcObject?.getTracks().forEach(t => t.stop()); await startCam(); }
  catch { facing = prev; try { await startCam(); } catch {} }
};

// ================= voice + sound =================
let voiceOn = JSON.parse(localStorage.getItem("caliVoice") ?? "true");
let lastSpoken = "", lastSpokenAt = 0;
function say(text, force = false) {
  if (!voiceOn || !("speechSynthesis" in window)) return;
  const now = performance.now();
  if (!force && (text === lastSpoken || now - lastSpokenAt < 3500)) return;
  lastSpoken = text; lastSpokenAt = now;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/—/g, ","));
  u.rate = 1.02; u.lang = "en-GB";
  speechSynthesis.speak(u);
}
$("voice").textContent = voiceOn ? "🔊" : "🔇";
$("voice").onclick = () => { voiceOn = !voiceOn; localStorage.setItem("caliVoice", JSON.stringify(voiceOn));
  $("voice").textContent = voiceOn ? "🔊" : "🔇"; if (voiceOn) say("voice coach on", true); else speechSynthesis.cancel(); };

let audio = null;
function initAudio() { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
function beep(freq = 880, dur = 0.09, gain = 0.06, when = 0) {
  if (!audio || !voiceOn) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq; o.type = "sine";
  g.gain.setValueAtTime(gain, audio.currentTime + when);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + when + dur);
  o.connect(g); g.connect(audio.destination);
  o.start(audio.currentTime + when); o.stop(audio.currentTime + when + dur + 0.02);
}
const sfx = {
  rep: () => beep(740, 0.07),
  milestone: () => { beep(880, 0.09); beep(1175, 0.12, 0.06, 0.11); },
  ready: () => beep(587, 0.12, 0.05),
  pb: () => { beep(659, 0.1); beep(880, 0.1, 0.06, 0.12); beep(1319, 0.22, 0.07, 0.24); },
};

// ================= framing coach (setup guidance) =================
const FRAME_SET = [0, 11, 12, 15, 16, 23, 24, 27, 28];
let readySince = 0, wasReady = false, lastGuide = "", lastGuideAt = 0;
function framingGuide(lm) {
  if (!lm) return "step into frame";
  const vis = i => lm[i].visibility ?? 0;
  const headOk = vis(0) > 0.4, feetOk = vis(27) > 0.35 || vis(28) > 0.35;
  if (!headOk && !feetOk) return "step into frame";
  if (!feetOk) return "feet out of frame — step back or tilt the camera down";
  if (!headOk) return "head out of frame — step back";
  const pts = FRAME_SET.filter(i => vis(i) > 0.35).map(i => lm[i]);
  if (pts.length < 5) return "step into frame";
  const ys = pts.map(p => p.y), xs = pts.map(p => p.x);
  const h = Math.max(...ys) - Math.min(...ys);
  if (h < 0.42) return "come closer";
  if (Math.min(...ys) < 0.015 && Math.max(...ys) > 0.985) return "step back";
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (cx < 0.22 || cx > 0.78) return "move toward the centre of the frame";
  // side-on check only when upright (standing)
  const torso = Math.abs((lm[11].y + lm[12].y) / 2 - (lm[23].y + lm[24].y) / 2);
  const shoDx = Math.abs(lm[11].x - lm[12].x);
  if (torso > 0.12 && shoDx > 0.55 * torso) return "turn side-on to the camera";
  return null;
}
function framingTick(lm, out, now) {
  if (out.mode !== "READY" && out.mode !== "IN FRAME") { wasReady = true; return null; }   // never nag mid-movement
  const guide = framingGuide(lm);
  if (guide) {
    readySince = 0;
    if (wasReady || (guide !== lastGuide && now - lastGuideAt > 3000)) {
      lastGuide = guide; lastGuideAt = now; wasReady = false; say(guide);
    }
    return guide;
  }
  if (!readySince) readySince = now;
  if (now - readySince > 900 && !wasReady) {
    wasReady = true; sfx.ready(); say("you're in frame — ready when you are", true);
  }
  return wasReady ? null : "hold still…";
}

// ================= movement announcements =================
const ACTIVE = new Set(["HANDSTAND", "PUSH-UP", "PLANK", "SQUAT", "PULL-UP", "FRONT LEVER", "L-SIT", "PIKE", "BRIDGE",
  "SUPPORT", "DEAD HANG", "DEEP SQUAT"]);
const MODE_SAY = { HANDSTAND: "handstand — timer running", "PUSH-UP": "push-ups — counting", PLANK: "plank detected — hold it",
  SQUAT: "squats — counting", "PULL-UP": "pull-ups — counting", "FRONT LEVER": "front lever — hold it",
  "L-SIT": "L-sit — hold it", PIKE: "pike fold — sink into it", BRIDGE: "bridge — push up",
  SUPPORT: "support hold — lock it out", "DEAD HANG": "dead hang — relax and hang", "DEEP SQUAT": "deep squat — sink and hold" };
let prevMode = "READY", toast = null, milestoneNext = 0;
function announceTick(out, now) {
  if (out.mode !== prevMode) {
    if (ACTIVE.has(out.mode)) {
      toast = { text: out.mode, until: now + 1600 };
      say(MODE_SAY[out.mode] || out.mode, true);
      milestoneNext = 10;
    }
    prevMode = out.mode;
  }
  if (out.holdSecs != null && out.holdSecs >= milestoneNext) {
    sfx.milestone(); say(`${milestoneNext} seconds`, true); milestoneNext += 10;
  }
}

// ================= canvas HUD =================
let lastCue = "", lastCueAt = 0;
function setCue(c) { const now = performance.now();
  if (c && c !== lastCue && now - lastCueAt > 1200) { lastCue = c; lastCueAt = now; }
  if (!c) lastCue = ""; }
function scoreCol(s) { return s >= 85 ? "#4cae6a" : s >= 65 ? "#e0a73a" : "#f0564b"; }
const MODE_COL = { HANDSTAND: null, "PUSH-UP": "#58a6ff", PLANK: "#a371f7", SQUAT: "#d29922", "PULL-UP": "#3fb950",
  "FRONT LEVER": "#f0564b", "L-SIT": "#e0a73a", PIKE: "#4cae6a", BRIDGE: "#db61a2",
  SUPPORT: "#3fb950", "DEAD HANG": "#58a6ff", "DEEP SQUAT": "#d29922", "IN FRAME": "#9aa4ad", READY: "#9aa4ad" };

function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function pill(text, cx, y, font, fg, bg = "#0d1014b8") {
  ctx.font = font;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bg; roundRect(cx - w / 2 - 16, y - 8, w + 32, parseInt(font) * 1.7, 14); ctx.fill();
  ctx.fillStyle = fg; ctx.fillText(text, cx - w / 2, y);
}
let CLEAN = false;   // showcase mode: strip all chrome (branding, mode bar, guide, toast, daily) — just the person, skeleton, alignment line + score
function paintHUD(out, guide) {
  const W = canvas.width, H = canvas.height, s = Math.min(W, H) / 720;
  ctx.save(); ctx.textBaseline = "top";
  if (!CLEAN) {
    ctx.font = `800 ${28 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillStyle = "#ffffffd9"; ctx.fillText("CALI", 24 * s, 22 * s);
    ctx.fillStyle = "#e0a73a"; ctx.fillText("COACH", 24 * s + ctx.measureText("CALI ").width, 22 * s);
    ctx.font = `700 ${13 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillStyle = "#4cae6a"; ctx.fillText("✓ VERIFIED · scored live on-device", 24 * s, 54 * s);
    ctx.font = `700 ${14 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillStyle = dailyDoneToday() ? "#4cae6a" : "#e0a73a";
    ctx.fillText(`☀ Daily: ${NAMES[dailyKind] || dailyKind}${dailyDoneToday() ? " ✓" : ""}`, 24 * s, 76 * s);
    const bits = [out.mode];
    if (out.holdSecs != null) bits.push(out.holdSecs.toFixed(1) + "s");
    if (out.reps != null) bits.push(out.reps + " reps");
    if (duel.on) bits.push(`⚔ ${duel.turn}`);
    if (board.dev && board.liveStab != null && out.mode === "HANDSTAND") bits.push(`base ${board.liveStab}`);
    pill(bits.join("  ·  "), W / 2, 26 * s, `700 ${22 * s}px -apple-system,system-ui,sans-serif`, "#e9eef3");
    if (guide) pill(guide, W / 2, H * 0.62, `700 ${26 * s}px -apple-system,system-ui,sans-serif`, "#e0a73a");
  } else if (out.holdSecs != null) {
    // clean mode: just the quiet hold timer, no pill / no black bar
    ctx.font = `800 ${30 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillStyle = "#e9eef3"; ctx.shadowColor = "#000"; ctx.shadowBlur = 12 * s;
    ctx.fillText(out.holdSecs.toFixed(1) + "s", 26 * s, 24 * s); ctx.shadowBlur = 0;
  }
  if (CLEAN && guide) pill(guide, W / 2, H * 0.62, `700 ${28 * s}px -apple-system,system-ui,sans-serif`, "#e0a73a");
  if (out.score != null) {
    ctx.font = `800 ${110 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillStyle = scoreCol(out.score);
    ctx.shadowColor = "#000"; ctx.shadowBlur = 18 * s;
    ctx.fillText(String(Math.round(out.score)), 26 * s, H - 150 * s);
    ctx.shadowBlur = 0;
  }
  if (!CLEAN && lastCue) pill(lastCue, W / 2, H - 52 * s, `700 ${24 * s}px -apple-system,system-ui,sans-serif`, "#e9eef3");
  const now = performance.now();
  if (!CLEAN && toast && now < toast.until) {
    ctx.globalAlpha = Math.min(1, (toast.until - now) / 400);
    pill("● " + toast.text, W / 2, H * 0.40, `800 ${44 * s}px -apple-system,system-ui,sans-serif`, "#e0a73a", "#0d1014d9");
    ctx.globalAlpha = 1;
  } else if (toast && now >= toast.until) toast = null;
  ctx.restore();
}


// ================= form goggles: director's view + L/R balance (est.) =================
// Today's session (9 Jul): the "form goggles" overlay — a circular POV of the athlete's FACE
// (rotated upright while they're inverted) + a camera-ESTIMATED left/right loading bar (the
// pre-hardware stand-in for the CaliHome heat map). Paints on the canvas -> recordings, PB
// clips and the tablet cast all get it for free. Handstand mode only. Defensive by design.
let _balEMA = null;
function paintGoggles(lm, out) {
  if (!lm || out.mode !== "HANDSTAND") { _balEMA = null; return; }
  const W = canvas.width, H = canvas.height, s = Math.min(W, H) / 720;
  const SX = p => (mirrored ? (1 - p.x) : p.x) * W, SY = p => p.y * H;
  const vis = i => (lm[i]?.visibility ?? 0) > 0.4;

  // ---- director's view: circular face PiP, top-right, rotated so the face reads upright ----
  try {
    if (vis(0)) {
      const nx = SX(lm[0]), ny = SY(lm[0]);
      let hr = 0.05 * H;
      if (vis(7) && vis(8)) hr = Math.max(hr, Math.hypot(SX(lm[7]) - SX(lm[8]), SY(lm[7]) - SY(lm[8])) * 1.35);
      else if (vis(2) && vis(5)) hr = Math.max(hr, Math.hypot(SX(lm[2]) - SX(lm[5]), SY(lm[2]) - SY(lm[5])) * 2.2);
      const sx = Math.max(0, nx - hr), sy = Math.max(0, ny - hr);
      const sw = Math.min(2 * hr, W - sx), sh = Math.min(2 * hr, H - sy);
      const R = 0.10 * Math.min(W, H), cx = W - R - 20 * s, cy = R + 24 * s;
      const tc = window.__tabcam;
      const useTab = tc && tc.readyState >= 2 && tc.videoWidth > 0;
      if (useTab || (sw > 8 && sh > 8 && (Math.abs(cx - nx) > R + hr || Math.abs(cy - ny) > R + hr))) {
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
        if (useTab) {                                         // the REAL POV: the tablet looking up at you
          const vw = tc.videoWidth, vh = tc.videoHeight, m = Math.min(vw, vh);
          ctx.drawImage(tc, (vw - m) / 2, (vh - m) / 2, m, m, cx - R, cy - R, 2 * R, 2 * R);
        } else {
          ctx.translate(cx, cy); ctx.rotate(Math.PI);         // fallback: cropped upright face
          ctx.drawImage(canvas, sx, sy, sw, sh, -R, -R, 2 * R, 2 * R);
        }
        ctx.restore();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7);
        ctx.lineWidth = 4 * s; ctx.strokeStyle = scoreCol(out.score ?? 50); ctx.stroke();
        ctx.font = `800 ${11 * s}px -apple-system,system-ui,sans-serif`;
        ctx.fillStyle = "#e9eef3"; ctx.shadowColor = "#000"; ctx.shadowBlur = 6 * s;
        const t = "DIRECTOR'S VIEW";
        ctx.fillText(t, cx - ctx.measureText(t).width / 2, cy + R + 8 * s);
        ctx.shadowBlur = 0;
      }
    }
  } catch {}

  // ---- L/R balance bar (camera-estimated: body line position between the wrist bases) ----
  try {
    if (vis(15) && vis(16) && vis(11) && vis(12) && vis(23) && vis(24)) {
      const w1 = SX(lm[15]), w2 = SX(lm[16]);
      const span = Math.abs(w1 - w2);
      if (span > 0.06 * W) {
        const mid = (w1 + w2) / 2;
        const com = (SX(lm[11]) + SX(lm[12]) + SX(lm[23]) + SX(lm[24])) / 4;
        let pctL = Math.max(0, Math.min(100, ((mid - com) / span + 0.5) * 100));
        _balEMA = _balEMA == null ? pctL : _balEMA + 0.25 * (pctL - _balEMA);
        pctL = _balEMA;
        const bw = 0.44 * W, bh = 12 * s, bx = (W - bw) / 2, by = H - 100 * s;
        const diff = Math.abs(pctL - 50);
        const heavy = diff < 8 ? "#4cae6a" : diff < 20 ? "#e0a73a" : "#f0564b";
        ctx.save();
        ctx.fillStyle = "#0d1014b8"; roundRect(bx - 6 * s, by - 6 * s, bw + 12 * s, bh + 12 * s, 8 * s); ctx.fill();
        ctx.fillStyle = pctL >= 50 ? heavy : "#3a4048"; ctx.fillRect(bx, by, bw * pctL / 100, bh);
        ctx.fillStyle = pctL < 50 ? heavy : "#3a4048"; ctx.fillRect(bx + bw * pctL / 100, by, bw * (100 - pctL) / 100, bh);
        ctx.fillStyle = "#e9eef3"; ctx.fillRect(bx + bw / 2 - 1, by - 3 * s, 2, bh + 6 * s);
        ctx.font = `800 ${15 * s}px -apple-system,system-ui,sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(`L ${Math.round(pctL)}`, bx - 46 * s, by + bh / 2);
        ctx.fillText(`${Math.round(100 - pctL)} R`, bx + bw + 10 * s, by + bh / 2);
        ctx.font = `700 ${10 * s}px -apple-system,system-ui,sans-serif`;
        ctx.fillStyle = "#9aa4ad";
        ctx.fillText("BALANCE (est)", bx + bw / 2 - 34 * s, by - 14 * s);
        ctx.restore();
      }
    } else _balEMA = null;
  } catch {}
}

// ================= confetti + PB =================
let particles = [], banner = null;
function celebrate(text) {
  banner = { text, until: performance.now() + 3200 };
  const cols = ["#e0a73a", "#4cae6a", "#58a6ff", "#db61a2", "#f0564b", "#ffffff"];
  for (let i = 0; i < 160; i++) particles.push({
    x: canvas.width / 2, y: canvas.height * 0.42, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 18 - 4,
    c: cols[i % cols.length], r: 4 + Math.random() * 6, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.4 });
  sfx.pb(); say(text, true);
}
function paintParty(now) {
  const s = Math.min(canvas.width, canvas.height) / 720;
  particles = particles.filter(pt => pt.y < canvas.height + 30);
  for (const pt of particles) {
    pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.5; pt.rot += pt.vr;
    ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(pt.rot);
    ctx.fillStyle = pt.c; ctx.fillRect(-pt.r / 2, -pt.r / 2, pt.r, pt.r * 1.6); ctx.restore();
  }
  if (banner && now < banner.until) {
    ctx.save(); ctx.textBaseline = "top";
    pill(banner.text, canvas.width / 2, canvas.height * 0.31, `800 ${52 * s}px -apple-system,system-ui,sans-serif`, "#e0a73a", "#0d1014d9");
    ctx.restore();
  } else if (banner && now >= banner.until) banner = null;
}
const pbs = JSON.parse(localStorage.getItem("caliPBs") || "{}");
function checkPB(e) {
  const k = e.type, prev = pbs[k] || { secs: 0, avg: 0 };
  let msg = null;
  if ("secs" in e && e.secs > prev.secs) msg = `NEW PB — ${e.secs}s ${k.replace("_", " ")}`;
  else if (e.avg > prev.avg + 0.5) msg = `NEW BEST FORM — ${Math.round(e.avg)}`;
  if (msg) {
    pbs[k] = { secs: Math.max(prev.secs, e.secs ?? 0), avg: Math.max(prev.avg, e.avg) };
    localStorage.setItem("caliPBs", JSON.stringify(pbs));
    celebrate(msg); e.pb = true;
  }
}

// ================= history (localStorage journal) =================
const journal = JSON.parse(localStorage.getItem("caliJournal") || "[]");
function journalAdd(e) {
  journal.push({ type: e.type, secs: e.secs, reps: e.reps, avg: e.avg, pb: !!e.pb, player: e.player, at: e.at,
    trace: e.trace ? downsample(e.trace, 40) : undefined });
  if (journal.length > 2000) journal.splice(0, journal.length - 2000);
  localStorage.setItem("caliJournal", JSON.stringify(journal));
}
function streak() {
  const days = new Set(journal.map(j => j.at.slice(0, 10)));
  let n = 0; const d = new Date();
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if (days.has(key)) { n++; d.setDate(d.getDate() - 1); }
    else if (n === 0 && key === new Date().toISOString().slice(0, 10)) { d.setDate(d.getDate() - 1); } // today not trained yet
    else break;
    if (n > 3650) break;
  }
  return n;
}

// ================= duel mode =================
const duel = { on: false, turn: "A", scores: { A: [], B: [] } };
function duelTick(e) {
  if (!duel.on) return;
  e.player = duel.turn;
  duel.scores[duel.turn].push(e.avg);
  duel.turn = duel.turn === "A" ? "B" : "A";
  say(`Player ${duel.turn}, you're up`, true);
}

// ================= freeze-frame "why this score" =================
let bestShot = null, lastShotAt = 0;
function shotTick(lm, out, now) {
  if (!ACTIVE.has(out.mode) || out.score == null) return;
  if ((!bestShot || out.score > bestShot.score) && now - lastShotAt > 400) {
    lastShotAt = now;
    let angles = null;
    if (out.mode === "HANDSTAND" && lm) {
      const C = chain(lm, pickSide(lm));
      const r = handstandScore(C.wri, C.sho, C.hip, C.kne, C.ank);
      angles = { shoulder: Math.round(r.shoulder), hip: Math.round(r.hip), knee: Math.round(r.knee), lean: Math.round(r.lean * 10) / 10 };
    }
    bestShot = { url: canvas.toDataURL("image/jpeg", 0.7), score: out.score, angles };
  }
}

// ================= auto-record =================
const MIME = ["video/mp4", "video/webm;codecs=vp9", "video/webm"].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
let rec = null, recChunks = [], recStopTimer = 0, canvasStream = null, wasActive = false;
function recStart() {
  if (!MIME || rec) return;
  canvasStream ||= canvas.captureStream(30);
  recChunks = [];
  rec = new MediaRecorder(canvasStream, { mimeType: MIME, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = ev => { if (ev.data.size) recChunks.push(ev.data); };
  rec.start(1000);
  $("recdot").hidden = false;
}
function recStop(attachTo) {
  if (!rec) return;
  const r = rec; rec = null; $("recdot").hidden = true;
  r.onstop = () => {
    if (recChunks.length && attachTo) {
      attachTo.clip = URL.createObjectURL(new Blob(recChunks, { type: MIME }));
      attachTo.clipExt = MIME.startsWith("video/mp4") ? "mp4" : "webm";
    }
    recChunks = [];
  };
  r.stop();
}
function recTick(out) {
  const active = ACTIVE.has(out.mode);
  if (active && !wasActive) { clearTimeout(recStopTimer); recStopTimer = 0; recStart(); hideSaveBtn(); }
  if (!active && wasActive && rec && !recStopTimer)
    recStopTimer = setTimeout(() => { recStopTimer = 0; recStop(session[session.length - 1]); }, 2000);
  wasActive = active;
}

// ================= tilt compensation (beta, off by default) =================
let tiltOn = JSON.parse(localStorage.getItem("caliTilt") ?? "false");
let deviceRoll = 0;
function requestTilt() {
  const handler = ev => {
    const o = (screen.orientation?.type || "portrait").startsWith("portrait");
    deviceRoll = (o ? ev.gamma : ev.beta) ?? 0;
  };
  if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
    DeviceOrientationEvent.requestPermission().then(p => { if (p === "granted") addEventListener("deviceorientation", handler); }).catch(() => {});
  } else addEventListener("deviceorientation", handler);
}
function levelLandmarks(lm) {
  if (!tiltOn || !lm || Math.abs(deviceRoll) < 1.5 || Math.abs(deviceRoll) > 15) return lm;
  const th = -deviceRoll * Math.PI / 180, W = canvas.width, H = canvas.height;
  const cos = Math.cos(th), sin = Math.sin(th);
  return lm.map(p => {
    const px = p.x * W - W / 2, py = p.y * H - H / 2;
    return { x: (px * cos - py * sin + W / 2) / W, y: (px * sin + py * cos + H / 2) / H, visibility: p.visibility };
  });
}

// ================= movement picker + workout runner =================
const KINDS = { handstand: "Handstand", stack_handstand: "Stack handstand",
  straddle_handstand: "Straddle handstand", kickup: "Kick-up to handstand",
  pushups: "Push-ups", squats: "Squats", pullups: "Pull-ups",
  plank: "Plank", front_lever: "Front lever", lsit: "L-sit", pike: "Pike fold", bridge: "Bridge",
  support: "Support hold", dead_hang: "Dead hang", deep_squat: "Deep squat" };
let locked = null;
function setLock(kind) {
  locked = kind; engine.lock(kind);
  $("pick").textContent = kind ? "🎯 " + KINDS[kind] : "🎯 AUTO";
  if (kind) say(`${KINDS[kind]} selected — get into position`, true);
  else say("auto-detect on", true);
}
const CIRCUIT = [
  { kind: "pushups", reps: 10 }, { kind: "plank", secs: 20 },
  { kind: "squats", reps: 10 }, { kind: "handstand", secs: 10 },
];
const workout = { steps: null, i: 0, resting: 0, done: false, startLen: 0 };
function workoutStart(steps) {
  workout.steps = steps; workout.i = 0; workout.resting = 0; workout.done = false;
  workoutStep();
  $("panel").classList.remove("open");
}
function workoutStep() {
  const s = workout.steps[workout.i];
  setLock(s.kind);
  workout.startLen = session.length;
  const what = s.reps ? `${s.reps} ${KINDS[s.kind].toLowerCase()}` : `${s.secs} second ${KINDS[s.kind].toLowerCase()}`;
  toast = { text: `${workout.i + 1}/${workout.steps.length} — ${what.toUpperCase()}`, until: performance.now() + 2500 };
  say(`Next: ${what}. Go when ready.`, true);
}
function workoutTick(out, now) {
  if (!workout.steps || workout.done) return null;
  if (workout.resting) {
    const left = Math.ceil((workout.resting - now) / 1000);
    if (left !== workout._lastLeft) { workout._lastLeft = left; if (left <= 3 && left > 0) beep(660 + (3 - left) * 110, 0.1); }
    if (left <= 0) { workout.resting = 0; workoutStep(); return null; }
    return `rest — ${left}s`;
  }
  const s = workout.steps[workout.i];
  let hit = false;
  if (s.reps && out.reps != null && out.reps >= s.reps) hit = true;
  if (s.secs && out.holdSecs != null && out.holdSecs >= s.secs) hit = true;
  if (hit) {
    sfx.milestone(); say("done — nice", true);
    workout.i++;
    if (workout.i >= workout.steps.length) {
      workout.done = true; workout.steps = null; setLock(null);
      celebrate("WORKOUT COMPLETE");
    } else { workout.resting = now + 20000; say("rest 20 seconds", true); }
  }
  const target = s.reps ? `${Math.min(out.reps ?? 0, s.reps)}/${s.reps}` : (out.holdSecs != null ? `${out.holdSecs.toFixed(0)}/${s.secs}s` : `target ${s.secs}s`);
  return `${workout.i + 1 <= workout.steps?.length ? (workout.i + 1) + "/" + workout.steps.length + " · " : ""}${KINDS[s.kind]} ${target}`;
}

// ================= debug overlay =================
let debugOn = JSON.parse(localStorage.getItem("caliDebug") ?? "false");
function paintDebug(lm, out) {
  if (!debugOn || !lm) return;
  const C = chain(lm, pickSide(lm));
  const flags = {
    inv: isInverted(C.wri, C.sho, C.hip, C.ank), hang: isHanging(C.wri, C.sho, C.hip),
    lever: isFrontLeverPose(C), bridge: isBridgePose(C), pike: isPikePose(C), lsit: isLsitPose(C),
    horiz: Math.abs(C.sho[1] - C.ank[1]) < 0.28 && C.wri[1] > C.sho[1] - 0.05,
  };
  const lines = [
    `mode ${out.mode}${locked ? " · LOCK " + locked : ""}`,
    `vis ${C.minVis.toFixed(2)}`,
    `elbow ${angleAt(C.sho, C.elb, C.wri).toFixed(0)}°  knee ${angleAt(C.hip, C.kne, C.ank).toFixed(0)}°`,
    `hipline ${angleAt(C.sho, C.hip, C.ank).toFixed(0)}°  lean ${torsoLean(C.sho, C.hip).toFixed(0)}°`,
    Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(" ") || "no posture",
  ];
  const s = Math.min(canvas.width, canvas.height) / 720;
  ctx.save(); ctx.textBaseline = "top"; ctx.font = `${15 * s}px ui-monospace,monospace`;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width));
  ctx.fillStyle = "#0d1014cc"; ctx.fillRect(canvas.width - w - 28 * s, 70 * s, w + 20 * s, lines.length * 20 * s + 12 * s);
  ctx.fillStyle = "#4cae6a";
  lines.forEach((l, i) => ctx.fillText(l, canvas.width - w - 18 * s, 78 * s + i * 20 * s));
  ctx.restore();
}

// ================= training-data traces (numeric only, no video) =================
let curTrace = [], lastTraceAt = 0;
function traceTick(lm, out, now) {
  if (!ACTIVE.has(out.mode) || !lm || now - lastTraceAt < 100) return;
  lastTraceAt = now;
  const C = chain(lm, pickSide(lm));
  curTrace.push([Math.round(now) % 1000000, Math.round(angleAt(C.sho, C.elb, C.wri)),
    Math.round(angleAt(C.hip, C.kne, C.ank)), Math.round(angleAt(C.sho, C.hip, C.ank)),
    Math.round(torsoLean(C.sho, C.hip) * 10) / 10]);
  if (curTrace.length > 1200) curTrace.shift();
}
function downsample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

// ================= ghost replay: race your own PB =================
const GHOST_PTS = [11,12,13,14,15,16,23,24,25,26,27,28];
const GHOST_SKEL = [[0,2],[2,4],[1,3],[3,5],[0,1],[0,6],[1,7],[6,7],[6,8],[8,10],[7,9],[9,11]];
let ghostOn = JSON.parse(localStorage.getItem("caliGhost_on") ?? "true");
let ghostRec = [], ghostStart = 0, ghostPlay = null, ghostBeaten = false, lastGhostSample = 0;
const ghosts = JSON.parse(localStorage.getItem("caliGhosts") || "{}");
const MODE_TO_KIND = { HANDSTAND: "handstand", PLANK: "plank", "FRONT LEVER": "front_lever",
  "L-SIT": "lsit", PIKE: "pike", BRIDGE: "bridge", SUPPORT: "support", "DEAD HANG": "dead_hang", "DEEP SQUAT": "deep_squat" };

function ghostTick(lm, out, now) {
  const active = ACTIVE.has(out.mode);
  if (active && !ghostStart) {
    ghostStart = now; ghostRec = []; ghostBeaten = false;
    const k = MODE_TO_KIND[out.mode];
    ghostPlay = ghostOn && k && ghosts[k] ? ghosts[k] : null;
    if (ghostPlay) say(`racing your best — ${ghostPlay.secs} seconds`, true);
  }
  if (!active && ghostStart) { ghostStart = 0; ghostPlay = null; }
  if (active && lm && now - lastGhostSample > 120 && ghostRec.length < 500) {
    lastGhostSample = now;
    ghostRec.push([Math.round(now - ghostStart), GHOST_PTS.map(i => [
      Math.round(lm[i].x * 1000) / 1000, Math.round(lm[i].y * 1000) / 1000])]);
  }
  if (active && ghostPlay) {
    const el = now - ghostStart;
    const fr = ghostPlay.frames;
    let f = fr[fr.length - 1];
    for (let i = 0; i < fr.length; i++) if (fr[i][0] >= el) { f = fr[i]; break; }
    ctx.save(); ctx.globalAlpha = 0.35; ctx.strokeStyle = "#e0a73a"; ctx.lineWidth = 5; ctx.lineCap = "round";
    for (const [a, b] of GHOST_SKEL) {
      ctx.beginPath();
      ctx.moveTo(f[1][a][0] * canvas.width, f[1][a][1] * canvas.height);
      ctx.lineTo(f[1][b][0] * canvas.width, f[1][b][1] * canvas.height);
      ctx.stroke();
    }
    ctx.restore();
    if (!ghostBeaten && el > ghostPlay.secs * 1000) {
      ghostBeaten = true;
      toast = { text: "👻 GHOST BEATEN", until: now + 2000 };
      say("you're past your best — keep going", true); sfx.milestone();
    }
  }
}
function ghostSave(e) {
  const holdKinds = ["handstand", "plank", "front_lever", "lsit", "pike", "bridge", "support", "dead_hang", "deep_squat"];
  if (!holdKinds.includes(e.type) || !ghostRec.length) return;
  const prev = ghosts[e.type];
  if (!prev || e.secs > prev.secs) {
    ghosts[e.type] = { secs: e.secs, avg: e.avg, frames: ghostRec.slice(0, 500) };
    try { localStorage.setItem("caliGhosts", JSON.stringify(ghosts)); } catch {}
  }
  ghostRec = [];
}

// ================= after-action report (skill debrief + instant replay) =================
// ghost joint order: 0 Lsho,1 Rsho,2 Lelb,3 Relb,4 Lwri,5 Rwri,6 Lhip,7 Rhip,8 Lkne,9 Rkne,10 Lank,11 Rank
const HOLD_KINDS = ["handstand", "plank", "front_lever", "lsit", "pike", "bridge", "support", "dead_hang", "deep_squat"];
const AAR_SKEL = [[0,2],[2,4],[1,3],[3,5],[0,1],[0,6],[1,7],[6,7],[6,8],[8,10],[7,9],[9,11]];
const acanvas = $("aarcanvas"), actx = acanvas.getContext("2d");
let aar = null;
function aarScore(p) { return handstandScore(p[4], p[0], p[6], p[8], p[10]); }   // left side
function aarPointers(frames, kind) {
  if (kind !== "handstand") return ["hold it longer and steadier next time"];
  const tally = {};
  for (const [, p] of frames) { const r = aarScore(p); if (r.score < 90) tally[r.cue] = (tally[r.cue] || 0) + 1; }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  return top.length ? top : ["clean lines — just hold it longer"];
}
function showReport(e, frames) {
  if (!HOLD_KINDS.includes(e.type) || !frames || frames.length < 3) return;
  let peak = e.avg;
  if (e.type === "handstand") { peak = 0; for (const [, p] of frames) peak = Math.max(peak, aarScore(p).score); }
  $("aar-kind").innerHTML = e.type === "handstand" ? 'HAND<span>STAND</span>' : e.type.replace("_", " ").toUpperCase();
  $("aar-head").textContent = `held ${e.secs}s`;
  $("aar-avg").textContent = Math.round(e.avg);
  $("aar-peak").textContent = Math.round(peak);
  $("aar-hold").textContent = e.secs + "s";
  const cuesEl = $("aar-cues"); cuesEl.innerHTML = "";
  if (e.avg >= 88) { const d = document.createElement("div"); d.className = "cue good"; d.textContent = "strong attempt — that was well stacked"; cuesEl.appendChild(d); }
  const pts = aarPointers(frames, e.type);
  for (const c of pts) { const d = document.createElement("div"); d.className = "cue"; d.textContent = "→ " + c; cuesEl.appendChild(d); }
  aar = { frames, kind: e.type, t0: performance.now(), dur: Math.max(1000, frames[frames.length - 1][0]) };
  $("aar").classList.add("show");
  say(`Held ${e.secs} seconds, form ${Math.round(e.avg)}. ${pts[0]}.`, true);
  aarLoop();
}
function aarLoop() {
  if (!aar) return; requestAnimationFrame(aarLoop);
  const W = acanvas.width = acanvas.clientWidth * devicePixelRatio, H = acanvas.height = acanvas.clientHeight * devicePixelRatio;
  if (!W || !H) return;
  actx.fillStyle = "#0d1014"; actx.fillRect(0, 0, W, H);
  const el = ((performance.now() - aar.t0) * 0.45) % (aar.dur + 600);   // 0.45x slo-mo, loop with a beat
  let f = aar.frames[0]; for (const fr of aar.frames) { if (fr[0] >= el) { f = fr; break; } f = fr; }
  const p = f[1];
  let minx = 1, maxx = 0, miny = 1, maxy = 0;
  for (const q of p) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); }
  const pad = 0.16, sw = maxx - minx || 1, sh = maxy - miny || 1, sc = Math.min(W * (1 - pad * 2) / sw, H * (1 - pad * 2) / sh);
  const ox = (W - sw * sc) / 2 - minx * sc, oy = (H - sh * sc) / 2 - miny * sc;
  const X = q => q[0] * sc + ox, Y = q => q[1] * sc + oy;
  const wr = p[4], hp = p[6], off = Math.abs(wr[0] - hp[0]);
  actx.setLineDash([10, 8]); actx.lineWidth = 3; actx.strokeStyle = off < 0.05 ? "#4cae6a" : off < 0.11 ? "#d29922" : "#f0564b";
  actx.beginPath(); actx.moveTo(X(wr), Y(wr)); actx.lineTo(X(wr), miny * sc + oy - H * 0.06); actx.stroke(); actx.setLineDash([]);
  actx.strokeStyle = "#e9eef3"; actx.lineWidth = Math.max(3, W * 0.012); actx.lineCap = "round";
  for (const [a, b] of AAR_SKEL) { actx.beginPath(); actx.moveTo(X(p[a]), Y(p[a])); actx.lineTo(X(p[b]), Y(p[b])); actx.stroke(); }
  actx.fillStyle = "#e0a73a"; for (const q of p) { actx.beginPath(); actx.arc(X(q), Y(q), Math.max(4, W * 0.008), 0, 7); actx.fill(); }
  if (aar.kind === "handstand") {
    actx.fillStyle = "#e0a73acc"; actx.textAlign = "left";
    actx.font = `800 ${W * 0.11}px -apple-system,system-ui,sans-serif`;
    actx.fillText(Math.round(aarScore(p).score), W * 0.05, H * 0.13);
  }
}
$("aar-ack").onclick = () => { aar = null; $("aar").classList.remove("show"); };

// ===== canvas review + REAL video-clip replay (draws the debrief ON the streamed canvas -> TABLET sees it) =====
let review = null; const REVIEW_MS = 10000;
let saveBtn = null;
function ensureSaveBtn() {
  if (saveBtn) return;
  saveBtn = document.createElement("button"); saveBtn.id = "saveclip"; saveBtn.textContent = "💾 Save clip";
  saveBtn.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:70;background:#e0a73a;"
    + "color:#1a1205;border:0;border-radius:28px;padding:15px 30px;font:800 18px -apple-system,system-ui,sans-serif;box-shadow:0 6px 22px #0009;display:none";
  saveBtn.onclick = () => {
    const i = review && review.idx; if (i == null || !session[i] || !session[i].clip) return;
    saveBtn.textContent = "saving…";
    Promise.resolve(window.shareClip(i)).catch(() => {}).finally(() => { saveBtn.textContent = "💾 Save clip"; });
  };
  document.body.appendChild(saveBtn);
}
function showSaveBtn() { ensureSaveBtn(); saveBtn.style.display = ""; clearTimeout(showSaveBtn._t); showSaveBtn._t = setTimeout(hideSaveBtn, 18000); }
function hideSaveBtn() { if (saveBtn) saveBtn.style.display = "none"; }
const clamp100 = x => Math.max(0, Math.min(100, x));
const RATING = a => a >= 92 ? "STACKED" : a >= 82 ? "SOLID" : a >= 70 ? "GETTING THERE" : "KEEP GOING";
function startReview(e, frames) {
  if (e.type !== "handstand" || !frames || frames.length < 3) return false;
  // average each body part across the hold -> a per-part breakdown (which bit let you down)
  let peak = 0, sSho = 0, sHip = 0, sKne = 0, sLn = 0, n = 0;
  for (const [, p] of frames) { const r = aarScore(p); peak = Math.max(peak, r.score);
    sSho += r.shoulder; sHip += r.hip; sKne += r.knee; sLn += r.lean; n++; }
  const sub = [
    ["SHOULDERS", clamp100(100 - 2.5 * Math.max(0, (180 - sSho / n) - 3))],
    ["HIPS",      clamp100(100 - 2.5 * Math.max(0, (180 - sHip / n) - 3))],
    ["LEGS",      clamp100(100 - 2.5 * Math.max(0, (180 - sKne / n) - 4))],
    ["STACK",     clamp100(100 - 5.0 * Math.max(0, (sLn / n) - 2))],
  ];
  review = { frames, e, idx: session.length - 1, secs: e.secs, avg: Math.round(e.avg), peak: Math.round(peak),
             rating: RATING(e.avg), sub, pointer: aarPointers(frames, "handstand")[0], t0: performance.now(), vid: null };
  say(`Held ${e.secs} seconds, form ${Math.round(e.avg)}. ${review.pointer}.`, true);
  sfx.milestone && sfx.milestone();
  return true;
}
function drawReview(now) {
  const W = canvas.width, H = canvas.height, s = Math.min(W, H) / 720;
  // the real footage attaches ~2s after the hold ends -> pick it up lazily and replay it slo-mo
  if (!review.vid && review.e && review.e.clip) {
    const v = document.createElement("video");
    v.src = review.e.clip; v.muted = true; v.loop = true; v.playsInline = true;
    try { v.playbackRate = 0.55; } catch {}
    v.play().catch(() => {});
    review.vid = v; showSaveBtn();
  }
  ctx.fillStyle = "#0d1014"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#161b22"; ctx.fillRect(0, 0, W, H * 0.135);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = "#e0a73a"; ctx.font = `800 ${34 * s}px -apple-system,system-ui,sans-serif`;
  ctx.fillText("HANDSTAND · REPLAY", W / 2, 30 * s);
  const boxT = H * 0.16, boxH = H * 0.4;
  if (review.vid && review.vid.readyState >= 2 && review.vid.videoWidth) {
    // the real clip (skeleton + line already baked in), fitted into the band
    const vw = review.vid.videoWidth, vh = review.vid.videoHeight;
    const sc = Math.min(W * 0.92 / vw, boxH / vh), dw = vw * sc, dh = vh * sc;
    ctx.drawImage(review.vid, (W - dw) / 2, boxT + (boxH - dh) / 2, dw, dh);
  } else {
    // fallback: slo-mo skeleton + alignment-line replay until the footage is ready
    const dur = Math.max(1000, review.frames[review.frames.length - 1][0]);
    const el = ((now - review.t0) * 0.45) % (dur + 600);
    let f = review.frames[0]; for (const fr of review.frames) { if (fr[0] >= el) { f = fr; break; } f = fr; }
    const p = f[1];
    let minx = 1, maxx = 0, miny = 1, maxy = 0;
    for (const q of p) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); }
    const pad = 0.12, sw = maxx - minx || 1, sh = maxy - miny || 1, sc = Math.min(W * (1 - pad * 2) / sw, boxH / sh);
    const ox = (W - sw * sc) / 2 - minx * sc, oy = boxT + (boxH - sh * sc) / 2 - miny * sc;
    const X = q => q[0] * sc + ox, Y = q => q[1] * sc + oy;
    const wr = p[4], hp = p[6], off = Math.abs(wr[0] - hp[0]);
    ctx.setLineDash([12, 9]); ctx.lineWidth = 3 * s; ctx.strokeStyle = off < 0.05 ? "#4cae6a" : off < 0.11 ? "#d29922" : "#f0564b";
    ctx.beginPath(); ctx.moveTo(X(wr), Y(wr)); ctx.lineTo(X(wr), boxT - H * 0.01); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = "#e9eef3"; ctx.lineWidth = Math.max(3, W * 0.011); ctx.lineCap = "round";
    for (const [a, b] of AAR_SKEL) { ctx.beginPath(); ctx.moveTo(X(p[a]), Y(p[a])); ctx.lineTo(X(p[b]), Y(p[b])); ctx.stroke(); }
    ctx.fillStyle = "#e0a73a"; for (const q of p) { ctx.beginPath(); ctx.arc(X(q), Y(q), Math.max(4, W * 0.007), 0, 7); ctx.fill(); }
  }
  const by = boxT + boxH + H * 0.03;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  // score + rating word + stats
  ctx.fillStyle = scoreCol(review.avg); ctx.font = `800 ${92 * s}px -apple-system,system-ui,sans-serif`;
  ctx.shadowColor = "#000"; ctx.shadowBlur = 14 * s; ctx.fillText(String(review.avg), W / 2, by); ctx.shadowBlur = 0;
  ctx.fillStyle = scoreCol(review.avg); ctx.font = `900 ${24 * s}px -apple-system,system-ui,sans-serif`;
  ctx.fillText(review.rating, W / 2, by + 96 * s);
  ctx.fillStyle = "#8b8778"; ctx.font = `700 ${17 * s}px -apple-system,system-ui,sans-serif`;
  ctx.fillText(`peak ${review.peak}  ·  held ${review.secs}s`, W / 2, by + 126 * s);
  // the per-body-part breakdown (which bit let you down)
  const bw = Math.min(W * 0.19, 240 * s), gap = bw * 0.28, rowW = bw * 4 + gap * 3;
  let bx = (W - rowW) / 2, byBar = by + 158 * s;
  ctx.textAlign = "center";
  for (const [label, val] of review.sub) {
    const col = val >= 85 ? "#4cae6a" : val >= 65 ? "#e0a73a" : "#f0564b";
    ctx.fillStyle = "#8b8778"; ctx.font = `800 ${13 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillText(label, bx + bw / 2, byBar);
    ctx.fillStyle = "#2a2a24"; roundRect(bx, byBar + 20 * s, bw, 9 * s, 4 * s); ctx.fill();
    ctx.fillStyle = col; roundRect(bx, byBar + 20 * s, bw * val / 100, 9 * s, 4 * s); ctx.fill();
    ctx.fillStyle = col; ctx.font = `800 ${17 * s}px -apple-system,system-ui,sans-serif`;
    ctx.fillText(Math.round(val), bx + bw / 2, byBar + 34 * s);
    bx += bw + gap;
  }
  ctx.fillStyle = "#e9eef3"; ctx.font = `700 ${23 * s}px -apple-system,system-ui,sans-serif`;
  ctx.fillText("Work on:  " + review.pointer, W / 2, byBar + 66 * s);
  ctx.textAlign = "left";
  const prog = Math.min(1, (now - review.t0) / REVIEW_MS);
  ctx.fillStyle = "#e0a73a"; ctx.fillRect(0, H - 6 * s, W * (1 - prog), 6 * s);
}
function endReview() { try { review && review.vid && review.vid.pause(); } catch {} review = null; }
try { canvas.addEventListener("click", () => { if (review) endReview(); }); } catch {}

// ================= daily move =================
const KIND_ORDER = ["handstand", "pushups", "squats", "plank", "lsit", "pullups", "pike", "bridge", "front_lever"];
const dailyKind = KIND_ORDER[Math.floor(Date.now() / 86400000) % KIND_ORDER.length];
function dailyDoneToday() {
  const today = new Date().toISOString().slice(0, 10);
  return journal.some(j => j.type === dailyKind && j.at.slice(0, 10) === today);
}
function dailyTick(e) {
  if (e.type === dailyKind && !e._dailyChecked) {
    e._dailyChecked = true;
    const today = new Date().toISOString().slice(0, 10);
    const already = journal.filter(j => j.type === dailyKind && j.at.slice(0, 10) === today).length;
    if (already <= 1) { e.daily = true; celebrate("DAILY MOVE ✓"); }
  }
}

// ================= skeleton + ghost =================
const SKEL = [[11,13],[13,15],[12,14],[14,16],[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(lm, col) {
  ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = "round";
  for (const [a, b] of SKEL) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    ctx.beginPath(); ctx.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height);
    ctx.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height); ctx.stroke();
  }
  ctx.fillStyle = col;
  for (const i of [11,12,13,14,15,16,23,24,25,26,27,28]) {
    if ((lm[i].visibility ?? 1) < 0.4) continue;
    ctx.beginPath(); ctx.arc(lm[i].x * canvas.width, lm[i].y * canvas.height, 6, 0, 7); ctx.fill();
  }
}
// live STACK line: the vertical from your wrists. Goes GREEN when your hips stack over
// your wrists, amber when you drift, red on a banana. Feedback, not just a reference.
function ghostLine(lm) {
  const wSide = (lm[15].visibility ?? 0) >= (lm[16].visibility ?? 0) ? 15 : 16;
  const hSide = wSide === 15 ? 23 : 24;
  const off = Math.abs(lm[wSide].x - lm[hSide].x);        // hips-vs-wrists horizontal offset (0 = stacked)
  const col = off < 0.05 ? "#4cae6a" : off < 0.11 ? "#d29922" : "#f0564b";
  const x = lm[wSide].x * canvas.width;
  ctx.save();
  ctx.setLineDash([14, 10]); ctx.lineWidth = 3; ctx.globalAlpha = 0.85; ctx.strokeStyle = col;
  ctx.beginPath(); ctx.moveTo(x, lm[wSide].y * canvas.height); ctx.lineTo(x, 0); ctx.stroke();
  ctx.restore();
}

// ================= the loop =================
function loop() {
  requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2) return;
  if (review) {                                   // handstand debrief on the streamed canvas -> tablet sees it
    if (performance.now() - review.t0 < REVIEW_MS) { drawReview(performance.now()); return; }
    endReview();
  }
  ctx.save();
  if (mirrored) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const res = landmarker.detectForVideo(video, performance.now());
  const lm = levelLandmarks(res.landmarks?.[0] ?? null);
  const now = performance.now();

  const out = engine.feed(lm, now);
  let guide = framingTick(lm, out, now);
  const wGuide = workoutTick(out, now);
  if (wGuide) guide = wGuide;
  else if (!guide && locked && !ACTIVE.has(out.mode) && wasReady)
    guide = "get into position — " + KINDS[locked];
  traceTick(lm, out, now);
  announceTick(out, now);
  setCue(out.cue);
  if (out.cue) say(out.cue);
  if (lm) draw(lm, out.mode === "HANDSTAND" ? scoreCol(out.score ?? 50) : (MODE_COL[out.mode] || "#9aa4ad"));
  if (lm && out.mode === "HANDSTAND") ghostLine(lm);
  try{
    if (window.castLink && out.mode === "HANDSTAND" && out.holdSecs != null && out.holdSecs > 0.2 && !window.__castHold){ window.__castHold = true; castLink.send({ t: "start" }); }
    if (window.__castHold && out.mode !== "HANDSTAND") window.__castHold = false;
  }catch{}
  ctx.restore();                 // undo the mirror BEFORE any text, so words never render flipped
  shotTick(lm, out, now);
  ghostTick(lm, out, now);
  boardScoreTick(out, now);
  paintHUD(out, guide);
  try { paintGoggles(lm, out); } catch {}
  paintDebug(lm, out);
  paintParty(now);
  recTick(out);

  if (session.length > announced) {
    const e = session[session.length - 1]; announced = session.length;
    const prevReps = e.reps;
    if (bestShot) { e.shot = bestShot.url; e.angles = bestShot.angles; bestShot = null; }
    if (curTrace.length) { e.trace = downsample(curTrace, 120); curTrace = []; }
    const aarFrames = ghostRec.slice();       // capture the attempt's frames BEFORE ghostSave clears them
    ghostSave(e);
    checkPB(e);
    dailyTick(e);
    duelTick(e);
    journalAdd(e);
    // handstand + a tablet watching (showcase/mirror) -> draw the debrief ON the canvas so it streams;
    // otherwise the phone's DOM overlay. Both give score + slo-mo replay + what to work on.
    if (window.castLink) { try { castLink.send({ t: "hold", kind: e.type, secs: e.secs ?? 0, avg: e.avg ?? null, pb: !!e.pb }); } catch {} }
    if ((CLEAN || mirrorPeer) && !window.castLink && e.type === "handstand" && startReview(e, aarFrames)) { /* canvas review streams to the tablet */ }
    else showReport(e, aarFrames);            // skill debrief + instant replay (hold kinds only)
    // voice: reps announced here; holds are spoken inside showReport
    if (!e.pb && !HOLD_KINDS.includes(e.type)) say(`${prevReps} reps, average ${Math.round(e.avg)}`, true);
  }
  // rep tick sound
  if (out.reps != null && out.reps > (loop._reps ?? 0)) sfx.rep();
  loop._reps = out.reps ?? 0;
}

// ================= panel: session / history / settings =================
const NAMES = { handstand: "Handstand", plank: "Plank", front_lever: "Front lever", lsit: "L-sit",
  pike: "Pike fold", bridge: "Bridge", pushups: "Push-ups", squats: "Squats", pullups: "Pull-ups" };

$("pick").onclick = () => { renderPicker(); $("panel").classList.add("open"); };
function renderPicker() {
  $("paneltitle").textContent = "Movement";
  $("coachbtn").hidden = true; $("coachout").hidden = true;
  const b = (label, on, fn) => `<button class="${on ? "gold" : "sec"}" style="width:auto;padding:10px 16px;font-size:14px" data-k="${fn}">${label}</button>`;
  $("panelbody").innerHTML =
    `<div class="item"><b>Guided workout</b><div style="margin-top:8px">` +
    `<button class="gold" id="startcircuit">▶ Starter circuit (push-ups · plank · squats · handstand)</button></div></div>` +
    `<div class="item"><b>Or lock one movement</b> — the coach judges only what you declare:<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" id="kindrow">` +
    b("AUTO", !locked, "") + Object.entries(KINDS).map(([k, n]) => b(n, locked === k, k)).join("") +
    `</div></div>`;
  $("startcircuit").onclick = () => workoutStart(CIRCUIT.slice());
  $("kindrow").querySelectorAll("button").forEach(btn =>
    btn.onclick = () => { setLock(btn.dataset.k || null); workout.steps = null; renderPicker(); });
}
$("sessionbtn").onclick = () => { renderSession(); $("panel").classList.add("open"); };
$("historybtn").onclick = () => { renderHistory(); $("panel").classList.add("open"); };
$("settings").onclick = () => { renderSettings(); $("panel").classList.add("open"); };
$("closepanel").onclick = () => $("panel").classList.remove("open");

const fmt = (e, i) => {
  const at = e.at.includes("T") ? e.at.slice(11, 19) : e.at;
  const pb = (e.pb ? ' <span style="color:#e0a73a">★ PB</span>' : "") + (e.daily ? ' <span style="color:#4cae6a">☀ DAILY</span>' : "");
  const player = e.player ? ` <span style="color:#58a6ff">[${e.player}]</span>` : "";
  const stats = "secs" in e && e.secs != null
    ? `${e.secs}s · score <b>${e.avg}</b>${e.min != null ? ` (min ${e.min})` : ""}${e.boardStability != null ? ` · base <b>${e.boardStability}</b>` : ""}`
    : `${e.reps} reps · avg <b>${e.avg}</b>${e.scores ? ` · [${e.scores.join(", ")}]` : ""}`;
  const btn = (label, fn) => `<button class="sec" style="width:auto;padding:8px 14px;font-size:13px" onclick="${fn}(${i})">${label}</button>`;
  const share = `<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">` +
    (e.clip ? btn("🎬 Share clip", "shareClip") : "") + btn("🖼 Share card", "shareCard") +
    (e.shot ? btn("📐 Why this score", "showWhy") : "") + `</div>`;
  return `<div class="item"><b>${NAMES[e.type] || e.type}</b>${pb}${player} · ${stats} · ${at}${share}</div>`;
};
function renderSession() {
  $("paneltitle").textContent = "Session";
  $("coachout").hidden = true;
  $("coachbtn").hidden = session.length === 0;
  let head = "";
  if (duel.on) {
    const best = p => duel.scores[p].length ? Math.max(...duel.scores[p]) : 0;
    const crown = best("A") === best("B") ? "" : best("A") > best("B") ? "A" : "B";
    head = `<div class="item">⚔ <b>DUEL</b> — A best <b>${best("A") || "–"}</b> vs B best <b>${best("B") || "–"}</b> ${crown ? "· 👑 Player " + crown : ""} · next up: <b>${duel.turn}</b></div>`;
  }
  const shareRow = session.length === 0 ? "" :
    `<div class="item" style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="gold" style="width:auto;padding:10px 16px" onclick="shareSessionCard()">🖼 Share session</button>
      <button class="sec" style="width:auto;padding:10px 16px" onclick="copyCaption()">📋 IG caption</button>
      <button class="sec" style="width:auto;padding:10px 16px" onclick="shareStrava()">🟠 Strava</button>
    </div>`;
  $("panelbody").innerHTML = shareRow + head + (session.length === 0
    ? '<div class="item">Nothing yet. Get in frame — it announces what it sees.</div>'
    : session.map((e, i) => fmt(e, i)).join(""));
}
function renderHistory() {
  $("paneltitle").textContent = "History";
  $("coachbtn").hidden = true; $("coachout").hidden = true;
  if (!journal.length) { $("panelbody").innerHTML = '<div class="item">No history yet — it saves automatically.</div>'; return; }
  const s = streak();
  const byType = {};
  for (const j of journal) (byType[j.type] ||= []).push(j);
  const bests = Object.entries(byType).map(([k, v]) => {
    const bAvg = Math.max(...v.map(x => x.avg));
    const bSecs = Math.max(...v.map(x => x.secs || 0));
    return `<div class="item"><b>${NAMES[k] || k}</b> · ${v.length} sessions · best score <b>${bAvg}</b>${bSecs ? ` · best hold <b>${bSecs}s</b>` : ""}</div>`;
  }).join("");
  const days = {};
  for (const j of journal.slice(-200)) (days[j.at.slice(0, 10)] ||= []).push(j);
  const recent = Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([d, v]) =>
    `<div class="item">${d} · ${v.length} entries · avg <b>${Math.round(v.reduce((a, x) => a + x.avg, 0) / v.length)}</b>${v.some(x => x.pb) ? ' · <span style="color:#e0a73a">★</span>' : ""}</div>`).join("");
  $("panelbody").innerHTML = `<div class="item">🔥 Streak: <b>${s} day${s === 1 ? "" : "s"}</b> · ${journal.length} lifetime entries</div>` + bests + recent;
}
function renderSettings() {
  $("paneltitle").textContent = "Settings";
  $("coachbtn").hidden = true; $("coachout").hidden = true;
  $("panelbody").innerHTML = `
    <div class="item">⚔ Duel mode (two athletes alternate attempts)
      <button class="${duel.on ? "gold" : "sec"}" style="margin-top:8px" id="dueltoggle">${duel.on ? "Duel ON — tap to end" : "Start duel"}</button></div>
    <div class="item">📐 Auto-level (beta) — corrects a tilted camera on phones. Live tilt: <b id="tiltval">${deviceRoll.toFixed(1)}°</b>
      <button class="${tiltOn ? "gold" : "sec"}" style="margin-top:8px" id="tilttoggle">${tiltOn ? "Auto-level ON" : "Auto-level OFF"}</button></div>
    <div class="item">🛹 CaliHome board — <button class="sec" style="width:auto;padding:8px 14px" id="boardbtn">${board.dev ? "connected ✓" : "Connect board"}</button>
      <span style="color:var(--sub);font-size:13px"> live base-stability fuses with the camera score; the board glows your form colour</span></div>
    <div class="item">📺 Mirror to a screen — on the CaliHome screen (or any phone/tablet on <b>calihome.html</b>) enter this code once; it remembers it and auto-connects after:
      <div id="mirrorrow" style="margin-top:8px"><button class="sec" id="mirrorbtn">Get mirror code</button></div></div>
    <div class="item">👻 Ghost — race a translucent replay of your best hold
      <button class="${ghostOn ? "gold" : "sec"}" style="margin-top:8px" id="ghosttoggle">${ghostOn ? "Ghost ON" : "Ghost OFF"}</button></div>
    <div class="item">🐞 Debug overlay — live posture flags + measured angles
      <button class="${debugOn ? "gold" : "sec"}" style="margin-top:8px" id="debugtoggle">${debugOn ? "Debug ON" : "Debug OFF"}</button></div>
    <div class="item">Anthropic API key (optional — unlocks the AI coach; stored only in this browser):
      <input id="apikey" type="password" placeholder="sk-ant-…" value="${localStorage.getItem("caliKey") || ""}">
      <button class="gold" style="margin-top:8px" id="savekey">Save</button></div>
    <div class="item" style="color:var(--sub)">Video never leaves this device — only the numeric session summary is sent to Claude when you ask the coach.</div>`;
  $("savekey").onclick = () => { localStorage.setItem("caliKey", $("apikey").value.trim()); $("panel").classList.remove("open"); };
  $("dueltoggle").onclick = () => { duel.on = !duel.on;
    if (duel.on) { duel.turn = "A"; duel.scores = { A: [], B: [] }; say("Duel on. Player A, you're up", true); }
    renderSettings(); };
  $("tilttoggle").onclick = () => { tiltOn = !tiltOn; localStorage.setItem("caliTilt", JSON.stringify(tiltOn)); renderSettings(); };
  $("debugtoggle").onclick = () => { debugOn = !debugOn; localStorage.setItem("caliDebug", JSON.stringify(debugOn)); renderSettings(); };
  $("ghosttoggle").onclick = () => { ghostOn = !ghostOn; localStorage.setItem("caliGhost_on", JSON.stringify(ghostOn)); renderSettings(); };
  $("boardbtn").onclick = async () => { try { await boardConnect(); renderSettings(); } catch (e) { say("board connection failed", true); } };
  $("mirrorbtn").onclick = async () => {
    $("mirrorbtn").textContent = "starting…";
    try { const c = await mirrorStart();
      $("mirrorrow").innerHTML = `<span style="font-size:30px;font-weight:800;letter-spacing:8px;color:var(--gold)">${c}</span>
        <div style="color:var(--sub);font-size:13px;margin-top:4px">open mirror.html on the screen device and enter this code</div>`;
    } catch { $("mirrorbtn").textContent = "mirror failed — retry"; }
  };
  const iv = setInterval(() => { const el = $("tiltval"); if (!el) return clearInterval(iv); el.textContent = deviceRoll.toFixed(1) + "°"; }, 300);
}

// ================= captions + Strava + session card =================
function entryLine(e) {
  const n = NAMES[e.type] || e.type;
  return "secs" in e && e.secs != null
    ? `${n} ${e.secs}s · ${Math.round(e.avg)}/100${e.boardStability != null ? ` · base ${e.boardStability}` : ""}${e.pb ? " ★PB" : ""}`
    : `${n} ${e.reps} reps · avg ${Math.round(e.avg)}${e.pb ? " ★PB" : ""}`;
}
function buildCaption() {
  const lines = session.map(entryLine).join("\n");
  const pbs = session.filter(e => e.pb).length;
  return `${lines}\n\n✓ Cali Verified — scored live by AI, on-device 🤸${pbs ? `\n${pbs} new PB${pbs > 1 ? "s" : ""} today` : ""}\ncaliunity.com  #calisthenics #caliverified #handstand`;
}
window.copyCaption = async () => {
  try { await navigator.clipboard.writeText(buildCaption()); say("caption copied", true); }
  catch { }
};
window.shareStrava = async () => {
  // TODAY: copy the summary + open Strava's manual entry. PROPER: OAuth edge fn (in the CaliDev package).
  try { await navigator.clipboard.writeText("Cali Coach session\n" + buildCaption()); } catch {}
  window.open("https://www.strava.com/upload/manual", "_blank");
};
window.shareSessionCard = () => {
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1920;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 1920);
  g.addColorStop(0, "#11161d"); g.addColorStop(1, "#0d1014");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
  x.textAlign = "center"; x.textBaseline = "top";
  x.font = "800 84px -apple-system,system-ui,sans-serif";
  x.fillStyle = "#e9eef3"; x.fillText("CALI COACH", 540, 130);
  x.font = "700 40px -apple-system,system-ui,sans-serif"; x.fillStyle = "#4cae6a";
  x.fillText("✓ VERIFIED SESSION — scored live by AI", 540, 240);
  x.font = "500 40px -apple-system,system-ui,sans-serif"; x.fillStyle = "#9aa4ad";
  const st = streak();
  x.fillText(new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) + (st > 1 ? `  ·  🔥 ${st}-day streak` : ""), 540, 320);
  // entries
  let y = 460;
  x.textAlign = "left";
  for (const e of session.slice(0, 9)) {
    x.font = "700 46px -apple-system,system-ui,sans-serif"; x.fillStyle = "#e9eef3";
    x.fillText(NAMES[e.type] || e.type, 110, y);
    x.textAlign = "right";
    const stat = "secs" in e && e.secs != null ? `${e.secs}s · ${Math.round(e.avg)}` : `${e.reps} × avg ${Math.round(e.avg)}`;
    x.fillStyle = e.pb ? "#e0a73a" : "#9aa4ad";
    x.fillText(stat + (e.pb ? " ★" : ""), 970, y);
    x.textAlign = "left";
    y += 96;
    x.strokeStyle = "#222a33"; x.beginPath(); x.moveTo(110, y - 28); x.lineTo(970, y - 28); x.stroke();
  }
  // footer totals
  const pbs = session.filter(e => e.pb).length;
  const holds = session.filter(e => "secs" in e && e.secs != null);
  const bestScore = Math.max(...session.map(e => e.avg));
  x.textAlign = "center";
  x.font = "800 120px -apple-system,system-ui,sans-serif"; x.fillStyle = "#e0a73a";
  x.fillText(`${session.length} movements${pbs ? ` · ${pbs} PB${pbs > 1 ? "s" : ""}` : ""}`, 540, Math.max(y + 60, 1450));
  x.font = "600 44px -apple-system,system-ui,sans-serif"; x.fillStyle = "#9aa4ad";
  x.fillText(`best score ${Math.round(bestScore)}${holds.length ? ` · longest hold ${Math.max(...holds.map(h => h.secs))}s` : ""}`, 540, Math.max(y + 210, 1600));
  x.fillStyle = "#e0a73a"; x.font = "700 46px -apple-system,system-ui,sans-serif";
  x.fillText("caliunity.com", 540, 1780);
  c.toBlob(b => shareFile(new File([b], "cali-session.png", { type: "image/png" }), buildCaption()), "image/png");
};

// ================= share =================
async function shareFile(file, text) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); return; } catch {}
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}
window.shareClip = async i => {
  const e = session[i];
  const blob = await (await fetch(e.clip)).blob();
  shareFile(new File([blob], `cali-${e.type}.${e.clipExt}`, { type: blob.type }),
            `${(NAMES[e.type] || e.type)} — score ${Math.round(e.avg)} on Cali Coach`);
};
window.shareCard = i => {
  const e = session[i];
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1920;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 1920);
  g.addColorStop(0, "#11161d"); g.addColorStop(1, "#0d1014");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
  x.textAlign = "center"; x.textBaseline = "top";
  x.font = "800 72px -apple-system,system-ui,sans-serif";
  x.fillStyle = "#e9eef3"; x.fillText("CALI COACH", 540, 200);
  x.font = "700 34px -apple-system,system-ui,sans-serif"; x.fillStyle = "#4cae6a";
  x.fillText("✓ VERIFIED — scored live by AI", 540, 292);
  x.font = "700 58px -apple-system,system-ui,sans-serif"; x.fillStyle = "#9aa4ad";
  x.fillText((NAMES[e.type] || e.type).toUpperCase(), 540, 372);
  x.beginPath(); x.arc(540, 830, 300, -Math.PI / 2, -Math.PI / 2 + (e.avg / 100) * Math.PI * 2);
  x.lineWidth = 40; x.strokeStyle = "#e0a73a"; x.lineCap = "round"; x.stroke();
  x.beginPath(); x.arc(540, 830, 300, 0, Math.PI * 2); x.lineWidth = 6; x.strokeStyle = "#2a313a"; x.stroke();
  x.font = "800 240px -apple-system,system-ui,sans-serif"; x.fillStyle = "#e0a73a";
  x.textBaseline = "middle"; x.fillText(String(Math.round(e.avg)), 540, 830);
  x.textBaseline = "top"; x.font = "700 64px -apple-system,system-ui,sans-serif"; x.fillStyle = "#e9eef3";
  const sub = "secs" in e && e.secs != null ? `${e.secs}s hold` : `${e.reps} reps`;
  x.fillText(sub + (e.pb ? "  ·  NEW PB" : ""), 540, 1230);
  x.font = "500 44px -apple-system,system-ui,sans-serif"; x.fillStyle = "#9aa4ad";
  x.fillText(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" }), 540, 1340);
  x.fillStyle = "#e0a73a"; x.font = "700 46px -apple-system,system-ui,sans-serif";
  x.fillText("caliunity.com", 540, 1720);
  c.toBlob(b => shareFile(new File([b], `cali-${e.type}.png`, { type: "image/png" }),
                          `${NAMES[e.type] || e.type} on Cali Coach`), "image/png");
};
window.showWhy = i => {
  const e = session[i];
  $("paneltitle").textContent = "Why this score";
  const a = e.angles;
  const rows = a ? `<div class="item">Shoulder line: <b>${a.shoulder}°</b> (180° = open) · Hip line: <b>${a.hip}°</b> (180° = no banana) ·
    Knees: <b>${a.knee}°</b> · Lean: <b>${a.lean}°</b> off vertical</div>` :
    `<div class="item">Best moment captured below — per-joint angle breakdown lands for more movements soon.</div>`;
  $("panelbody").innerHTML = `<img src="${e.shot}" style="width:100%;border-radius:12px">` + rows +
    `<div class="item" style="color:var(--sub)">Score ${e.avg} — this frame was your best moment.</div>`;
  $("coachbtn").hidden = true;
};

// ================= AI coach =================
$("coachbtn").onclick = async () => {
  const key = localStorage.getItem("caliKey");
  const out = $("coachout"); out.hidden = false;
  if (!key) { out.textContent = "No API key set — add one in ⚙ settings to unlock the AI coach."; return; }
  out.textContent = "coach is thinking…";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01",
                 "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 350,
        system: "You are the Cali calisthenics coach: direct, warm, expert. British English. Never use em dashes or en dashes. Given session data (handstand alignment and plank line scores out of 100; push-up scores from depth, body line, lockout; squat scores from depth, torso, lockout; pull-up scores from range of motion; front lever from hip line and horizontality; L-sit from leg height; pike fold and bridge from joint angles, all out of 100), give: 1) one-line verdict, 2) the single biggest fix with a concrete drill, 3) one thing they did well. Max 90 words.",
        messages: [{ role: "user", content: "Session data: " + JSON.stringify(session.map(({ clip, shot, trace, ...rest }) => rest)) }] }) });
    const j = await r.json();
    out.textContent = j.content?.[0]?.text || ("API error: " + JSON.stringify(j.error || j).slice(0, 300));
  } catch (e) { out.textContent = "network error: " + e.message; }
};

// ================= CaliHome board link (Web Bluetooth; firmware_v3 contract) =================
const BOARD = { SVC: "ca110000-0000-1000-8000-00805f9b34fb",
  HOLD: "ca110002-0000-1000-8000-00805f9b34fb", LIVE: "ca110007-0000-1000-8000-00805f9b34fb",
  REC: "ca110003-0000-1000-8000-00805f9b34fb", CMD: "ca110005-0000-1000-8000-00805f9b34fb" };
const board = { dev: null, cmd: null, live: null, holds: [], lastScoreSent: 0 };
const dec2 = new TextDecoder();
async function boardConnect() {
  if (!navigator.bluetooth) { say("web bluetooth needs Chrome", true); return false; }
  const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [BOARD.SVC] }] });
  const srv = await (await dev.gatt.connect()).getPrimaryService(BOARD.SVC);
  board.dev = dev; board.cmd = await srv.getCharacteristic(BOARD.CMD);
  const hold = await srv.getCharacteristic(BOARD.HOLD);
  await hold.startNotifications();
  hold.addEventListener("characteristicvaluechanged", ev => {
    const v = dec2.decode(ev.target.value);
    if (v.startsWith("{")) {                            // board hold ended -> fusion pool
      const h = JSON.parse(v);
      board.holds.push({ secs: h.secs, stab: h.stab, endedAtMs: Date.now() });
      // late-fuse onto the latest camera handstand within the window
      for (let i = session.length - 1; i >= Math.max(0, session.length - 3); i--) {
        const e = session[i];
        if (e.type === "handstand" && !e.boardStability
            && Math.abs(Date.parse(e.at) - Date.now()) < 4000
            && Math.abs(e.secs - h.secs) <= 0.35 * Math.max(e.secs, h.secs)) {
          e.boardStability = h.stab; say(`base stability ${h.stab}`, true); break;
        }
      }
    }
  });
  try { board.live = await srv.getCharacteristic(BOARD.LIVE);
    await board.live.startNotifications();
    board.live.addEventListener("characteristicvaluechanged", ev => {
      try { board.liveStab = JSON.parse(dec2.decode(ev.target.value)).stab; } catch {}
    });
  } catch {}
  dev.addEventListener("gattserverdisconnected", () => { board.dev = null; say("board disconnected", true); });
  say("CaliHome board connected", true);
  return true;
}
async function boardScoreTick(out, now) {              // glow the board with the live camera score
  if (!board.cmd || out.score == null || now - board.lastScoreSent < 700) return;
  board.lastScoreSent = now;
  try { await board.cmd.writeValue(new TextEncoder().encode("SCORE:" + Math.round(out.score))); } catch {}
}

// ================= mirror casting (board screen = any device on mirror.html) =================
let mirrorPeer = null, mirrorCode = null;
async function mirrorStart() {
  if (mirrorPeer) return mirrorCode;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  const rnd = () => Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
  // STABLE code: reuse this phone's saved code so a paired CaliHome tablet auto-reconnects for good.
  mirrorCode = localStorage.getItem("caliMirrorCode") || rnd();
  localStorage.setItem("caliMirrorCode", mirrorCode);
  canvasStream ||= canvas.captureStream(30);
  let idTries = 0;
// ICE: STUN only. (A dead public TURN was stalling ICE and made pairing WORSE - removed 9 Jul.
// When we run our own TURN (coturn/Cloudflare), add it here and cross-network gets bulletproof.)
const ICE_CFG = { config: { iceServers: [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
] } };
  const wire = code => {
    mirrorPeer = new Peer("cali-" + code, ICE_CFG);
    mirrorPeer.on("connection", conn => {
      conn.on("data", () => {                          // mirror-hello -> call back with the canvas
        mirrorPeer.call(conn.peer, canvasStream);
        say("mirror connected", true);
      });
    });
    mirrorPeer.on("open", () => { idTries = 0; });      // got our id back cleanly
    mirrorPeer.on("error", e => {
      // broker still holds our id from the last session: wait for it to release and RETRY THE SAME code
      // (do NOT mint a new code, that is what broke the "pair once" promise). New code only as a last resort.
      if (e.type === "unavailable-id") {
        try { mirrorPeer.destroy(); } catch {} mirrorPeer = null;
        if (++idTries <= 5) setTimeout(() => wire(code), 1500);
        else { mirrorCode = rnd(); localStorage.setItem("caliMirrorCode", mirrorCode); idTries = 0; wire(mirrorCode); }
      }
    });
    mirrorPeer.on("disconnected", () => { try { mirrorPeer.reconnect(); } catch {} });
  };
  wire(mirrorCode);
  return new Promise(res => { const t = setInterval(() => { if (mirrorPeer && mirrorPeer.open) { clearInterval(t); res(mirrorCode); } }, 120); });
}

// ================= showcase / locked mode (gym CaliHome) =================
// ?only=handstand  -> lock to one movement, hide the picker/session/history so nothing can be
// changed, and surface the CaliHome cast code as a persistent banner (auto-starts the mirror).
(function showcase() {
  const only = new URLSearchParams(location.search).get("only");
  if (!only || !KINDS[only]) return;
  CLEAN = true;                                   // strip all HUD chrome for the showcase
  voiceOn = true; localStorage.setItem("caliVoice", "true");   // voice coach ON automatically
  try { $("voice").textContent = "🔊"; } catch {}
  // Lock to the one movement IMMEDIATELY (do not wait for the camera) and hide every control that
  // could change it, so the coach opens already pinned to handstand with no picker / auto-detect.
  // opened from a CaliHome QR: strip the generic multi-movement copy — it's a handstand mirror.
  try{
    const sp = document.querySelector("#splash p");
    if (sp) sp.textContent = "Allow the camera, prop your phone side-on, kick up. You'll appear on the CaliHome screen.";
    const h1 = document.querySelector("#splash h1"); if (h1) h1.innerHTML = "CALI<b>HOME</b>";
  }catch{}
  const HIDE = ["pick", "sessionbtn", "historybtn", "settings", "sub"];
  const lock = () => { try { if (locked !== only) setLock(only); } catch {} };
  const hide = () => HIDE.forEach(id => { const el = $(id); if (el) el.style.display = "none"; });
  lock(); hide();
  // Keep it locked + hidden (defend against any re-render), and start the CaliHome cast banner
  // once the camera loop is live so the canvas actually streams.
  const CAST0 = new URLSearchParams(location.search).get("cast");
  if (CAST0) {
    const b = document.createElement("div"); b.id = "castbanner";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:60;background:#1A1A1Eef;color:#ECE7DB;"
      + "font:600 15px/1.35 -apple-system,system-ui,sans-serif;padding:9px 12px;text-align:center;letter-spacing:.02em";
    b.textContent = "📺 finding your CaliHome screen…"; document.body.appendChild(b);
    linkCast(CAST0.toUpperCase(), b);          // WARM: signalling connects while they read the splash
  }
  let casted = false;
  setInterval(() => {
    lock(); hide();
    if (!casted && !document.getElementById("splash")) {
      casted = true;
      if (CAST0 && window.castLink) {
        const b = document.getElementById("castbanner");
        if (b) b.textContent = "📺 connecting to CaliHome…";
        canvasStream ||= canvas.captureStream(30);
        castLink.attach(canvasStream);
        setTimeout(() => {                    // classic PeerJS fallback if the link never lands
          const bb = document.getElementById("castbanner");
          if (bb && !bb.innerHTML.includes("connected")) mirrorStart().then(c => pushCast(CAST0.toUpperCase(), bb, c)).catch(() => {});
        }, 18000);
      } else {
        const b = document.createElement("div"); b.id = "castbanner";
        b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:60;background:#1A1A1Eef;color:#ECE7DB;"
          + "font:600 15px/1.35 -apple-system,system-ui,sans-serif;padding:9px 12px;text-align:center;letter-spacing:.02em";
        b.textContent = "📺 starting CaliHome cast…"; document.body.appendChild(b);
        mirrorStart()
          .then(c => { b.innerHTML = `📺 CaliHome code <b style="color:#F2B208;letter-spacing:5px;font-size:20px">${c}</b> &nbsp;enter it on the gym screen`; })
          .catch(() => { b.textContent = "📺 cast unavailable — check wifi"; });
      }
    }
  }, 400);
})();


// scanned from a CaliHome QR (?cast=ROOM): the phone connects TO the tablet - nobody types anything.
let pushT = null;
function pushCast(room, banner, myCode){
  const target = "calihome-" + room;
  const fallback = () => { banner.innerHTML = `📺 CaliHome code <b style="color:#F2B208;letter-spacing:5px;font-size:20px">${myCode}</b> &nbsp;enter it on the gym screen`; };
  const attempt = () => {
    if (!mirrorPeer || !mirrorPeer.open){ clearTimeout(pushT); pushT = setTimeout(attempt, 1200); return; }
    try{
      const conn = mirrorPeer.connect(target, { reliable: true });
      let opened = false;
      conn.on("open", () => {
        opened = true;
        try { mirrorPeer.call(target, canvasStream); } catch {}
        banner.innerHTML = '📺 <b style="color:#5ec97e">connected to CaliHome</b> — kick up!';
        setTimeout(() => { try{ banner.style.opacity = ".6"; }catch{} }, 3000);
        conn.on("close", () => { banner.style.opacity = "1"; banner.textContent = "📺 reconnecting to CaliHome…"; clearTimeout(pushT); pushT = setTimeout(attempt, 1500); });
      });
      conn.on("error", () => { if (!opened){ clearTimeout(pushT); pushT = setTimeout(attempt, 2500); } });
      const onPeerErr = e => { if (e.type === "peer-unavailable" && !opened){ try{ mirrorPeer.off("error", onPeerErr); }catch{}; clearTimeout(pushT); pushT = setTimeout(attempt, 2000); } };
      try{ mirrorPeer.on("error", onPeerErr); }catch{}
      setTimeout(() => {
        try{ mirrorPeer.off("error", onPeerErr); }catch{}
        if (!opened){ try{ conn.close(); }catch{}; clearTimeout(pushT); pushT = setTimeout(attempt, 1500); }   // ALWAYS retry — never strand "connecting…"
      }, 8000);
    }catch{ clearTimeout(pushT); pushT = setTimeout(attempt, 2500); }
  };
  setTimeout(() => { if (banner.textContent.includes("connecting")) fallback(); }, 20000);  // never strand them: show the manual code if push can't land
  attempt();
}


// visible build stamp (bottom-left, tiny) so live-version checks never need devtools
try {
  const vd = document.createElement("div");
  vd.textContent = "v33 · 09 Jul 21:45";
  vd.style.cssText = "position:fixed;left:8px;bottom:6px;z-index:55;font:600 10px ui-monospace,monospace;color:#ECE7DB;opacity:.35;pointer-events:none";
  document.body.appendChild(vd);
} catch {}


// QR-scanned pairing over CaliLink (Supabase-signalled). PeerJS/manual stays as the fallback.
const loadScript = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
async function linkCast(room, banner){
  try{
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    await loadScript("calilink.js");
    window.castLink = CaliLink.cast(room, null, { onTrack: s => {
      try{ const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.autoplay = true;
        v.srcObject = s; v.play?.().catch(()=>{}); window.__tabcam = v; }catch{}
    }, onState: st => {
      if (st === "connected"){ banner.innerHTML = '📺 <b style="color:#5ec97e">connected to CaliHome</b> — kick up!'; setTimeout(() => { try{ banner.style.opacity = ".6"; }catch{} }, 3000); }
      else if (st === "found") banner.innerHTML = '📺 <b style="color:#5ec97e">CaliHome found ✓</b> — tap Start camera';
      else if (st === "waiting") banner.textContent = "📺 looking for the CaliHome screen…";
      else if (st === "retry"){ banner.style.opacity = "1"; banner.textContent = "📺 reconnecting to CaliHome…"; }
    }});
  }catch(e){
    banner.textContent = "📺 cast unavailable — check wifi";
    try{ mirrorStart().then(c => pushCast(room, banner, c)); }catch{}
  }
}

// ================= PWA =================
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
