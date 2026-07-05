# CaliCoach scoring engine — PYTHON REFERENCE + test-vector generator.
# The production scorer is JS (inside index.html / scorer.js). This file is the
# independent implementation: same maths, synthetic ground-truth skeletons, and
# it emits test_vectors.json that the JS scorer must reproduce to <1e-6.
# Run: ~/.venvs/cad/bin/python scoring_reference.py
import json, math
import numpy as np

# MediaPipe pose indices (the subset we use), coords normalised, y DOWN.
LM = dict(nose=0, l_sho=11, r_sho=12, l_elb=13, r_elb=14, l_wri=15, r_wri=16,
          l_hip=23, r_hip=24, l_kne=25, r_kne=26, l_ank=27, r_ank=28)

def angle_at(A, B, C):
    """Angle at B (degrees) between BA and BC."""
    v1 = (A[0]-B[0], A[1]-B[1]); v2 = (C[0]-B[0], C[1]-B[1])
    d = (v1[0]*v2[0] + v1[1]*v2[1])
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0: return 180.0
    return math.degrees(math.acos(max(-1, min(1, d/n))))

def lean_from_vertical(P, Q):
    """Angle of P->Q vs vertical (deg). y is down, vertical = (0,-1) direction agnostic."""
    dx, dy = Q[0]-P[0], Q[1]-P[1]
    return math.degrees(math.atan2(abs(dx), abs(dy)))

# ---------------- HANDSTAND ----------------
# side view chain: wrist -> shoulder -> hip -> knee -> ankle
# deficits: shoulder open (target 180), hip line (banana/pike), knee bend, global lean
W_SHO, W_HIP, W_KNE, W_LEAN = 0.8, 0.9, 0.4, 1.2

def handstand_score(wri, sho, hip, kne, ank):
    sho_a = angle_at(wri, sho, hip)
    hip_a = angle_at(sho, hip, kne)
    kne_a = angle_at(hip, kne, ank)
    lean = lean_from_vertical(wri, hip)
    # deadzone: a few degrees of tolerance (landmark noise + human margin) so a near-perfect line
    # reads ~100 and the score is less jittery / less harsh on legs.
    d_sho = max(0.0, (180 - sho_a) - 3.0)
    d_hip = max(0.0, (180 - hip_a) - 3.0)
    d_kne = max(0.0, (180 - kne_a) - 4.0)
    d_lean = max(0.0, lean - 2.0)
    score = 100 - W_SHO*d_sho - W_HIP*d_hip - W_KNE*d_kne - W_LEAN*d_lean
    score = max(0.0, min(100.0, score))
    # cue: a big fold at the hip is a pike (legs forward); a subtle arch is a banana (ribs flared)
    hip_cue = "open the pike — bring your legs over" if (180 - hip_a) > 40 else "ribs in — kill the banana"
    worst = max((d_sho*W_SHO, "open your shoulders"), (d_hip*W_HIP, hip_cue),
                (d_kne*W_KNE, "squeeze your legs straight"), (d_lean*W_LEAN, "stack over your wrists"))
    cue = "locked in — hold it" if score >= 90 else worst[1]
    return dict(score=round(score, 4), shoulder=round(sho_a, 4), hip=round(hip_a, 4),
                knee=round(kne_a, 4), lean=round(lean, 4), cue=cue)

def is_inverted(wri, sho, hip, ank):
    return wri[1] > hip[1] and ank[1] < sho[1]     # y down: wrists low, ankles high

# ---------------- PUSH-UP ----------------
# rep state machine on elbow angle; body line at the hip (sag/pike)
TOP_A, BOT_A = 155.0, 95.0

def pushup_frame(sho, elb, wri, hip, ank):
    elbow = angle_at(sho, elb, wri)
    line = angle_at(sho, hip, ank)                 # 180 = straight plank
    # sag vs pike: cross product sign of sho->ank x sho->hip (y down!)
    vx, vy = ank[0]-sho[0], ank[1]-sho[1]
    wx, wy = hip[0]-sho[0], hip[1]-sho[1]
    sag = (vx*wy - vy*wx) > 0                       # hip below the line = sag (y down)
    return elbow, 180-line, sag

def depth_score(min_elbow):
    if min_elbow <= 90: return 100.0
    if min_elbow >= 130: return 0.0
    return (130 - min_elbow) / 40 * 100

def line_score(mean_dev):
    return max(0.0, 100 - 5.0*mean_dev)            # 20 deg of sag/pike = 0

def rate_rep(min_elbow, mean_line_dev, top_elbow):
    d = depth_score(min_elbow); l = line_score(mean_line_dev)
    lock = 100.0 if top_elbow >= 165 else 50.0
    score = 0.5*d + 0.4*l + 0.1*lock
    if d < 60: cue = "go deeper — chest to the floor"
    elif l < 60: cue = "hips sagging — squeeze your glutes"
    elif lock < 100: cue = "finish the lockout"
    else: cue = "clean rep"
    return dict(score=round(score, 4), depth=round(d, 4), line=round(l, 4), cue=cue)

class RepCounter:
    """Elbow-angle state machine: TOP -> DOWN -> (bottom) -> UP -> TOP = 1 rep."""
    def __init__(s):
        s.state = "TOP"; s.min_elbow = 180.0; s.devs = []; s.reps = []
    def feed(s, elbow, line_dev):
        if s.state == "TOP":
            if elbow < TOP_A: s.state = "DOWN"; s.min_elbow = elbow; s.devs = [line_dev]
        elif s.state == "DOWN":
            s.min_elbow = min(s.min_elbow, elbow); s.devs.append(line_dev)
            if elbow > s.min_elbow + 15: s.state = "UP"
        elif s.state == "UP":
            s.devs.append(line_dev)
            if elbow >= TOP_A:
                s.reps.append(rate_rep(s.min_elbow, float(np.mean(s.devs)), elbow))
                s.state = "TOP"

# ---------------- SQUAT ----------------
# rep machine on knee angle (hip-knee-ankle); depth = knee angle at the bottom
SQ_TOP, SQ_BOT = 160.0, 100.0

def squat_depth_score(min_knee):
    if min_knee <= 90: return 100.0          # at/below parallel
    if min_knee >= 130: return 0.0           # quarter squat
    return (130 - min_knee) / 40 * 100

def squat_torso_score(mean_torso_lean):
    """Torso lean from vertical during the rep; some hinge is normal, excess is a fault."""
    return max(0.0, 100 - 2.5 * max(0.0, mean_torso_lean - 20))   # free hinge up to 20 deg

def rate_squat(min_knee, mean_torso_lean, top_knee):
    d = squat_depth_score(min_knee); t = squat_torso_score(mean_torso_lean)
    lock = 100.0 if top_knee >= 155 else 50.0
    score = 0.55*d + 0.35*t + 0.10*lock
    if d < 60: cue = "sit deeper — hip crease to the knee"
    elif t < 60: cue = "chest up — you're folding forward"
    elif lock < 100: cue = "stand all the way up"
    else: cue = "clean squat"
    return dict(score=round(score, 4), depth=round(d, 4), torso=round(t, 4), cue=cue)

class SquatCounter:
    def __init__(s): s.state="TOP"; s.min_knee=180.0; s.leans=[]; s.reps=[]
    def feed(s, knee, torso_lean):
        if s.state == "TOP":
            if knee < SQ_TOP: s.state="DOWN"; s.min_knee=knee; s.leans=[torso_lean]
        elif s.state == "DOWN":
            s.min_knee=min(s.min_knee, knee); s.leans.append(torso_lean)
            if knee > s.min_knee + 15: s.state="UP"
        elif s.state == "UP":
            s.leans.append(torso_lean)
            if knee >= SQ_TOP:
                s.reps.append(rate_squat(s.min_knee, float(np.mean(s.leans)), knee))
                s.state="TOP"

# ---------------- PLANK ----------------
def plank_score(mean_line_dev):
    """Hold quality purely from the body line (sag/pike)."""
    return max(0.0, min(100.0, 100 - 4.0*mean_line_dev))

# ---------------- PULL-UP ----------------
# hanging: wrists above shoulders above hips. Rep machine on elbow angle.
PL_TOP, PL_BOT = 160.0, 90.0

def pullup_rom_score(min_elbow):
    if min_elbow <= 60: return 100.0         # chin well over
    if min_elbow >= 110: return 0.0          # barely bent
    return (110 - min_elbow) / 50 * 100

def rate_pullup(min_elbow, top_elbow):
    # v1: score = ROM alone. (A half-reset never reaches the 160° hang threshold, so
    # it MERGES into the previous rep — undercounted reps punish it naturally.
    # A crossing-frame "dead hang" component was tried and removed: it fired on the
    # threshold frame and penalised perfect reps.)
    r = pullup_rom_score(min_elbow)
    cue = "pull higher — chin over the bar" if r < 60 else "clean pull-up"
    return dict(score=round(r, 4), rom=round(r, 4), cue=cue)

class PullupCounter:
    def __init__(s): s.state="HANG"; s.min_elbow=180.0; s.reps=[]
    def feed(s, elbow):
        if s.state == "HANG":
            if elbow < PL_TOP: s.state="PULL"; s.min_elbow=elbow
        elif s.state == "PULL":
            s.min_elbow=min(s.min_elbow, elbow)
            if elbow > s.min_elbow + 15: s.state="LOWER"
        elif s.state == "LOWER":
            if elbow >= PL_TOP:
                s.reps.append(rate_pullup(s.min_elbow, elbow))
                s.state="HANG"

# ---------------- SKILL + MOBILITY HOLDS (front lever, L-sit, pike, bridge) ----
# All are HOLDS: detected by posture, scored per frame, averaged over the hold.

def front_lever_score(sho, hip, kne, ank):
    """Hanging, body horizontal. Faults: hip pike, body dropping off horizontal, bent knees."""
    hip_a = angle_at(sho, hip, kne)
    kne_a = angle_at(hip, kne, ank)
    horiz_dev = math.degrees(math.atan2(abs(ank[1]-sho[1]), abs(ank[0]-sho[0])))  # 0 = horizontal
    score = max(0.0, min(100.0, 100 - 1.2*(180-hip_a) - 1.0*horiz_dev - 0.4*(180-kne_a)))
    worst = max(((180-hip_a)*1.2, "kill the pike — open your hips"),
                (horiz_dev*1.0, "lift — you're dropping off horizontal"),
                ((180-kne_a)*0.4, "squeeze your legs straight"))
    cue = "textbook lever — hold" if score >= 90 else worst[1]
    return dict(score=round(score, 4), hip=round(hip_a, 4), horiz=round(horiz_dev, 4),
                knee=round(kne_a, 4), cue=cue)

def lsit_score(hip, kne, ank):
    """Support hold, legs out. leg_angle: +ve = ankles ABOVE hip level (V-sit territory)."""
    leg_angle = math.degrees(math.atan2(hip[1]-ank[1], abs(ank[0]-hip[0])))
    kne_a = angle_at(hip, kne, ank)
    score = max(0.0, min(100.0, 85 + 1.5*leg_angle - 0.4*(180-kne_a)))
    if (180-kne_a) > 25: cue = "straighten your knees"
    elif leg_angle < -8: cue = "lift your legs — toes above hip height"
    elif score >= 95: cue = "that's a V — outstanding"
    else: cue = "strong L — press the floor away"
    return dict(score=round(score, 4), leg_angle=round(leg_angle, 4), knee=round(kne_a, 4), cue=cue)

def pike_score(sho, hip, kne, ank):
    """Seated pike fold. Fold angle at the hip (shoulder-hip-ankle); bent knees = cheating."""
    fold = angle_at(sho, hip, ank)
    kne_a = angle_at(hip, kne, ank)
    # 35 deg fold = elite = 100; 90 deg = upright L = 0. Bent knees penalised hard.
    base = max(0.0, min(100.0, (90 - fold) / 55 * 100))
    score = max(0.0, base - 1.0*(180-kne_a))
    if (180-kne_a) > 15: cue = "knees locked — a bent-knee fold doesn't count"
    elif score >= 85: cue = "beautiful fold — breathe and sink"
    else: cue = "hinge deeper — chest to thighs"
    return dict(score=round(score, 4), fold=round(fold, 4), knee=round(kne_a, 4), cue=cue)

def bridge_score(wri, sho, hip, kne):
    """Back bridge. Shoulder openness (wrist-shoulder-hip -> 180 = shoulders over wrists)
    + hip extension (shoulder-hip-knee -> 180)."""
    sho_a = angle_at(wri, sho, hip)
    hip_a = angle_at(sho, hip, kne)
    score = max(0.0, min(100.0, 100 - 1.2*(180-sho_a) - 0.6*(180-hip_a)))
    worst = max(((180-sho_a)*1.2, "push your chest over your hands — open the shoulders"),
                ((180-hip_a)*0.6, "drive your hips higher"))
    cue = "elite arch" if score >= 88 else worst[1]
    return dict(score=round(score, 4), shoulder=round(sho_a, 4), hip=round(hip_a, 4), cue=cue)

# ---------------- synthetic skeletons (ground truth) ----------------
def hs_skeleton(sho_open=180, hip_line=180, knee=180, lean=0):
    """Build a side-view handstand: wrist at bottom, chain upward with given angles."""
    seg = 0.18                                      # normalised segment length
    wri = (0.5, 0.9)
    up = math.radians(lean)                         # lean tilts the whole stack
    def step(p, ang_from_vert, L):
        return (p[0] + L*math.sin(ang_from_vert), p[1] - L*math.cos(ang_from_vert))
    a1 = up + math.radians(180 - sho_open) * 0      # arm along the stack
    sho = step(wri, up, seg)
    # torso bends by hip deficit at the shoulder->hip segment relative to arm line:
    torso_ang = up + math.radians(180 - sho_open)
    hip = step(sho, torso_ang, seg*1.2)
    thigh_ang = torso_ang + math.radians(180 - hip_line)
    kne = step(hip, thigh_ang, seg)
    shin_ang = thigh_ang + math.radians(180 - knee)
    ank = step(kne, shin_ang, seg)
    return wri, sho, hip, kne, ank

def pu_frames(depth_bottom=85, sag_deg=0, n=40):
    """Synthetic push-up: elbow 170 -> depth_bottom -> 170, constant body-line dev."""
    half = n//2
    angles = list(np.linspace(170, depth_bottom, half)) + list(np.linspace(depth_bottom, 170, n-half))
    return [(a, sag_deg) for a in angles]

# ---------------- generate vectors + self-test ----------------
vectors = {"handstand": [], "pushup_reps": []}
cases = [
    ("perfect", dict()),
    ("banana", dict(hip_line=162)),                 # 18 deg banana
    ("closed_shoulders", dict(sho_open=165)),
    ("bent_knees", dict(knee=150)),
    ("leaning", dict(lean=6)),
    ("everything_off", dict(sho_open=168, hip_line=165, knee=160, lean=4)),
]
print("HANDSTAND cases:")
for name, kw in cases:
    wri, sho, hip, kne, ank = hs_skeleton(**kw)
    r = handstand_score(wri, sho, hip, kne, ank)
    inv = is_inverted(wri, sho, hip, ank)
    print(f"  {name:18s} score {r['score']:6.1f}  sho {r['shoulder']:6.1f} hip {r['hip']:6.1f} "
          f"knee {r['knee']:6.1f} lean {r['lean']:5.2f}  inverted={inv}  cue: {r['cue']}")
    vectors["handstand"].append(dict(name=name, wri=wri, sho=sho, hip=hip, kne=kne, ank=ank, expect=r))
    assert inv, f"{name} must read as inverted"

# sanity ordering
s = {v["name"]: v["expect"]["score"] for v in vectors["handstand"]}
assert s["perfect"] > 97, "perfect must score ~100"
assert s["perfect"] > s["leaning"] > s["everything_off"], "score must degrade with faults"
assert s["banana"] < s["bent_knees"], "banana (weighted heavier) must cost more than bent knees"

print("\nPUSH-UP sets:")
pu_cases = [("deep_clean", 85, 0), ("half_rep", 115, 0), ("saggy_hips", 85, 12), ("shallow_and_saggy", 120, 10)]
for name, depth, sag in pu_cases:
    rc = RepCounter()
    frames = pu_frames(depth, sag) * 3              # 3 reps
    for elbow, dev in frames: rc.feed(elbow, dev)
    reps = rc.reps
    print(f"  {name:18s} reps {len(reps)}  scores {[r['score'] for r in reps]}  cue: {reps[0]['cue']}")
    vectors["pushup_reps"].append(dict(name=name, frames=frames, expect=reps))
    assert len(reps) == 3, f"{name}: must count exactly 3 reps"
v = {c[0]: vectors["pushup_reps"][i]["expect"][0]["score"] for i, c in enumerate(pu_cases)}
assert v["deep_clean"] > v["half_rep"] and v["deep_clean"] > v["saggy_hips"] > v["shallow_and_saggy"]

print("\nSQUAT sets:")
vectors["squat_reps"] = []
def sq_frames(depth_bottom, lean, n=40):
    half = n//2
    ks = list(np.linspace(170, depth_bottom, half)) + list(np.linspace(depth_bottom, 170, n-half))
    return [(k, lean) for k in ks]
sq_cases = [("deep_upright", 85, 12), ("parallel_ok", 95, 15), ("quarter_squat", 125, 10), ("deep_but_folded", 85, 45)]
for name, depth, lean in sq_cases:
    sc = SquatCounter()
    frames = sq_frames(depth, lean) * 3
    for k, l in frames: sc.feed(k, l)
    print(f"  {name:18s} reps {len(sc.reps)}  scores {[float(r['score']) for r in sc.reps]}  cue: {sc.reps[0]['cue']}")
    vectors["squat_reps"].append(dict(name=name, frames=frames, expect=sc.reps))
    assert len(sc.reps) == 3
v = {c[0]: vectors["squat_reps"][i]["expect"][0]["score"] for i, c in enumerate(sq_cases)}
assert v["deep_upright"] > v["parallel_ok"] > v["quarter_squat"], "depth must rank"
assert v["deep_upright"] > v["deep_but_folded"], "torso fold must cost"

print("\nPLANK holds:")
vectors["plank"] = [dict(dev=d, expect=round(plank_score(d), 4)) for d in (0, 3, 8, 15, 30)]
for c in vectors["plank"]: print(f"  line dev {c['dev']:>2}°  -> {c['expect']}")
assert plank_score(0) == 100 and plank_score(8) < plank_score(3) and plank_score(30) == 0

print("\nPULL-UP sets:")
vectors["pullup_reps"] = []
def pl_frames(min_elbow, n=40):
    half = n//2
    return list(np.linspace(175, min_elbow, half)) + list(np.linspace(min_elbow, 175, n-half))
pl_cases = [("full_rom", 55), ("chin_just", 75), ("half_rep", 105)]
for name, me in pl_cases:
    pc = PullupCounter()
    frames = pl_frames(me) * 3
    for e in frames: pc.feed(e)
    print(f"  {name:18s} reps {len(pc.reps)}  scores {[float(r['score']) for r in pc.reps]}  cue: {pc.reps[0]['cue']}")
    vectors["pullup_reps"].append(dict(name=name, frames=frames, expect=pc.reps))
    assert len(pc.reps) == 3
v = {c[0]: vectors["pullup_reps"][i]["expect"][0]["score"] for i, c in enumerate(pl_cases)}
assert v["full_rom"] > v["chin_just"] > v["half_rep"]

print("\nFRONT LEVER frames:")
vectors["front_lever"] = []
def fl_pose(hip_a=180, drop=0, knee=180):
    """Hanging horizontal: build the chain with a hip pike and a drop off horizontal."""
    sho = (0.35, 0.55)
    d = math.radians(drop)
    hipp = (sho[0] + 0.18*math.cos(d), sho[1] + 0.18*math.sin(d))
    t2 = d + math.radians(180 - hip_a)
    kne = (hipp[0] + 0.15*math.cos(t2), hipp[1] + 0.15*math.sin(t2))
    t3 = t2 + math.radians(180 - knee)
    ank = (kne[0] + 0.15*math.cos(t3), kne[1] + 0.15*math.sin(t3))
    return sho, hipp, kne, ank
for name, kw in [("textbook", {}), ("piked", dict(hip_a=155)), ("dropping", dict(drop=14)), ("bent_knees", dict(knee=150))]:
    sho, hipp, kne, ank = fl_pose(**kw)
    r = front_lever_score(sho, hipp, kne, ank)
    print(f"  {name:12s} score {r['score']:6.1f}  cue: {r['cue']}")
    vectors["front_lever"].append(dict(name=name, sho=sho, hip=hipp, kne=kne, ank=ank, expect=r))
s = {v["name"]: v["expect"]["score"] for v in vectors["front_lever"]}
assert s["textbook"] > 95 and s["textbook"] > s["bent_knees"] > s["piked"] and s["dropping"] < s["textbook"]

print("\nL-SIT frames:")
vectors["lsit"] = []
def ls_pose(leg_angle=0, knee=180):
    hip = (0.5, 0.6)
    a = math.radians(-leg_angle)          # y down: negative = up
    kne = (hip[0] + 0.15*math.cos(a), hip[1] + 0.15*math.sin(a))
    t = a + math.radians(180 - knee)
    ank = (kne[0] + 0.15*math.cos(t), kne[1] + 0.15*math.sin(t))
    return hip, kne, ank
for name, kw in [("L_horizontal", {}), ("V_sit", dict(leg_angle=10)), ("knees_low", dict(leg_angle=-15)), ("bent_knees", dict(knee=145))]:
    hip, kne, ank = ls_pose(**kw)
    r = lsit_score(hip, kne, ank)
    print(f"  {name:12s} score {r['score']:6.1f}  leg {r['leg_angle']:6.1f}°  cue: {r['cue']}")
    vectors["lsit"].append(dict(name=name, hip=hip, kne=kne, ank=ank, expect=r))
s = {v["name"]: v["expect"]["score"] for v in vectors["lsit"]}
assert s["V_sit"] > s["L_horizontal"] > s["knees_low"] and s["L_horizontal"] > s["bent_knees"]

print("\nPIKE folds:")
vectors["pike"] = []
def pk_pose(fold=90, knee=180):
    hip = (0.5, 0.75)
    ank = (hip[0] + 0.30, hip[1])                       # legs along the floor
    a = math.radians(-fold)                              # torso rotated up from the leg line
    sho = (hip[0] + 0.22*math.cos(a), hip[1] + 0.22*math.sin(a))
    kne = ((hip[0]+ank[0])/2, hip[1] - 0.30*math.sin(math.radians(180-knee))/2)
    return sho, hip, kne, ank
for name, kw in [("elite_fold", dict(fold=38)), ("working_fold", dict(fold=62)), ("upright_L", dict(fold=88)), ("bent_knee_cheat", dict(fold=45, knee=150))]:
    sho, hip, kne, ank = pk_pose(**kw)
    r = pike_score(sho, hip, kne, ank)
    print(f"  {name:15s} score {r['score']:6.1f}  fold {r['fold']:6.1f}°  cue: {r['cue']}")
    vectors["pike"].append(dict(name=name, sho=sho, hip=hip, kne=kne, ank=ank, expect=r))
s = {v["name"]: v["expect"]["score"] for v in vectors["pike"]}
assert s["elite_fold"] > s["working_fold"] > s["upright_L"] and s["elite_fold"] > s["bent_knee_cheat"]

print("\nBRIDGE frames:")
vectors["bridge"] = []
def br_pose(sho_open=180, hip_ext=180):
    """Angle-chain construction: arm vertical, torso rotated off collinear by the
    shoulder deficit, thigh rotated off the torso line by the hip deficit."""
    wri = (0.35, 0.85)
    sho = (wri[0], wri[1] - 0.12)                        # arm vertical (sho->wri points down, +90 deg)
    th = math.radians(-90 + (180 - sho_open))            # collinear continuation = straight up
    hip = (sho[0] + 0.20*math.cos(th), sho[1] + 0.20*math.sin(th))
    t2 = th + math.radians(180 - hip_ext)
    kne = (hip[0] + 0.16*math.cos(t2), hip[1] + 0.16*math.sin(t2))
    return wri, sho, hip, kne
for name, kw in [("elite_arch", {}), ("stiff_shoulders", dict(sho_open=145)), ("low_hips", dict(hip_ext=150)), ("stiff_everything", dict(sho_open=150, hip_ext=155))]:
    wri, sho, hip, kne = br_pose(**kw)
    r = bridge_score(wri, sho, hip, kne)
    print(f"  {name:16s} score {r['score']:6.1f}  cue: {r['cue']}")
    vectors["bridge"].append(dict(name=name, wri=wri, sho=sho, hip=hip, kne=kne, expect=r))
s = {v["name"]: v["expect"]["score"] for v in vectors["bridge"]}
assert s["elite_arch"] > 95 and s["elite_arch"] > s["stiff_shoulders"] > s["stiff_everything"] and s["low_hips"] < s["elite_arch"]

with open("test_vectors.json", "w") as f:
    json.dump(vectors, f)
total = sum(len(v) for v in vectors.values())
print(f"\nOK — all reference assertions passed. test_vectors.json: {total} cases across {len(vectors)} movement groups.")
