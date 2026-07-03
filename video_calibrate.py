# CALI COACH — exercise-library calibration pipeline.
# Feed it the CaliDev exercise-library videos (the hundreds of coach-filmed demos):
# it runs MediaPipe pose over each video, extracts the SAME angles the live scorers
# use, and emits per-exercise distributions → data-driven scorer constants.
#
#   ~/.venvs/cad/bin/python video_calibrate.py <folder> [--label pushups]
#
# Folder layout option A: videos named/foldered by exercise (pushups/vid1.mp4 ...).
# Option B: one folder + --label for all.
# Output: calibration_report.json + a printed table:
#   per exercise: angle mins/maxs/percentiles (elbow, knee, hip-line, torso lean,
#   fold, shoulder-line) → compare against the constants in scorer.js and retune.
#
# These are COACH DEMO videos = ground-truth "good form": the 10th percentile of
# coach depth becomes the 100-score anchor; the live scorers' linear bands get
# re-fitted between coach-anchor and fault-anchor. No ML training needed yet —
# this is calibration. (The same traces become training data later.)
#
# Requires: pip install mediapipe opencv-python (the cad venv has them).
import sys, json, math, pathlib
from collections import defaultdict

import numpy as np

def angle_at(A, B, C):
    v1 = (A[0]-B[0], A[1]-B[1]); v2 = (C[0]-B[0], C[1]-B[1])
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0: return 180.0
    return math.degrees(math.acos(max(-1, min(1, (v1[0]*v2[0]+v1[1]*v2[1])/n))))

def lean_v(P, Q):
    return math.degrees(math.atan2(abs(Q[0]-P[0]), abs(Q[1]-P[1])))

def process_video(path, pose):
    import cv2
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, int(fps / 10))                      # sample ~10 Hz
    frames, i = [], 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        if i % step == 0:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            import mediapipe as mp
            res = pose.process(rgb)
            if res.pose_landmarks:
                lm = res.pose_landmarks.landmark
                # side pick by visibility
                L, R = [11,13,15,23,25,27], [12,14,16,24,26,28]
                side = L if sum(lm[j].visibility for j in L) >= sum(lm[j].visibility for j in R) else R
                sho, elb, wri, hip, kne, ank = [(lm[j].x, lm[j].y) for j in side]
                if min(lm[j].visibility for j in side) > 0.4:
                    frames.append(dict(
                        elbow=angle_at(sho, elb, wri), knee=angle_at(hip, kne, ank),
                        hipline=angle_at(sho, hip, ank), lean=lean_v(hip, sho),
                        shoulderline=angle_at(wri, sho, hip),
                        fold=angle_at(sho, hip, ank)))
        i += 1
    cap.release()
    return frames

def summarise(frames):
    if not frames: return None
    out = {}
    for k in frames[0]:
        v = np.array([f[k] for f in frames])
        out[k] = dict(min=round(float(v.min()), 1), p10=round(float(np.percentile(v, 10)), 1),
                      p50=round(float(np.percentile(v, 50)), 1), p90=round(float(np.percentile(v, 90)), 1),
                      max=round(float(v.max()), 1))
    return out

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    root = pathlib.Path(sys.argv[1])
    label = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else None
    import mediapipe as mp
    pose = mp.solutions.pose.Pose(static_image_mode=False, model_complexity=1)

    vids = [p for p in root.rglob("*") if p.suffix.lower() in (".mp4", ".mov", ".webm", ".mkv", ".avi")]
    print(f"{len(vids)} videos under {root}")
    by_ex = defaultdict(list)
    for v in vids:
        ex = label or (v.parent.name if v.parent != root else v.stem.split("_")[0])
        print(f"  processing {v.name} -> {ex} ...", flush=True)
        by_ex[ex].extend(process_video(v, pose))

    report = {}
    for ex, frames in by_ex.items():
        s = summarise(frames)
        report[ex] = dict(frames=len(frames), stats=s)
        print(f"\n== {ex} ({len(frames)} sampled frames) ==")
        if s:
            for k, st in s.items():
                print(f"  {k:14s} min {st['min']:6.1f}  p10 {st['p10']:6.1f}  p50 {st['p50']:6.1f}  p90 {st['p90']:6.1f}  max {st['max']:6.1f}")
    out = root / "calibration_report.json"
    out.write_text(json.dumps(report, indent=1))
    print(f"\nreport -> {out}")
    print("Retune guide: e.g. push-up depth — coaches' p10 elbow at the bottom becomes the "
          "100-score anchor in depthScore(); pike fold p10 = the elite-fold anchor; etc. "
          "Update scorer constants + regenerate test vectors with a documented reason.")

if __name__ == "__main__":
    main()
