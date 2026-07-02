// NATIVE-TIER: vision-camera + pose frame processor + the CoachEngine.
// [Maker Ollie delivery — SCAFFOLD: the pose-plugin choice is yours, see options
// below; verify plugin APIs against the versions you install. The STABLE parts
// are scorer.ts + CoachEngine (test-vector verified) — do not fork the maths.]
//
// Pose plugin options (pick one, all output the needed landmarks):
//   A. react-native-mediapipe (community wrapper for MediaPipe Tasks) — same
//      33-landmark order as the web demo. Least adaptation.
//   B. @react-native-ml-kit/pose-detection or react-native-mlkit — MLKit's 33
//      landmarks use the SAME index convention; map visibility from inFrameLikelihood.
//   C. TFLite MoveNet via react-native-fast-tflite — 17 keypoints; needs an
//      index adapter (no knees→ankles chain change, but different indices).
// Whatever the source: produce Landmark[33] {x, y normalised, visibility} y-DOWN,
// call engine.feed(landmarks, timestampMs), render the returned CoachFrameOut.
import React, { useMemo, useRef, useState, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
// import { Camera, useCameraDevice, useFrameProcessor } from "react-native-vision-camera";
import { CoachEngine, type CoachFrameOut } from "./useCoachSession.ts";

export default function CoachCameraScreen() {
  const engine = useMemo(() => new CoachEngine(), []);
  const [out, setOut] = useState<CoachFrameOut>({ mode: "READY", score: null, cue: null, holdSecs: null, reps: null });

  useEffect(() => {
    engine.onLog = (e) => {
      // TODO(CaliDev): supabase.from("coach_sessions").insert(...) — see useCoachSession.ts footer
      console.log("session entry", e);
    };
  }, [engine]);

  // TODO(CaliDev): wire the chosen pose plugin here. Shape:
  // const frameProcessor = useFrameProcessor((frame) => {
  //   'worklet';
  //   const lm = posePlugin.detect(frame);          // -> Landmark[33], y down
  //   const res = engine.feed(lm, performance.now()); // run on JS thread via runOnJS if needed
  //   runOnJS(setOut)(res);
  // }, [engine]);

  return (
    <View style={s.root}>
      {/* <Camera style={StyleSheet.absoluteFill} device={device} isActive frameProcessor={frameProcessor} /> */}
      <View style={s.hud}>
        <Text style={s.mode}>{out.mode}{out.holdSecs != null ? ` · ${out.holdSecs.toFixed(1)}s` : ""}{out.reps != null ? ` · ${out.reps} reps` : ""}</Text>
        <Text style={s.score}>{out.score != null ? Math.round(out.score) : "--"}</Text>
        {out.cue ? <Text style={s.cue}>{out.cue}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1014" },
  hud: { position: "absolute", bottom: 90, left: 0, right: 0, alignItems: "center", gap: 6 },
  mode: { color: "#e0a73a", fontWeight: "700", fontSize: 14 },
  score: { color: "#e0a73a", fontWeight: "800", fontSize: 84, textShadowColor: "#000", textShadowRadius: 16 },
  cue: { color: "#e9eef3", fontWeight: "700", fontSize: 17, backgroundColor: "#161b22cc", paddingHorizontal: 14, paddingVertical: 7, borderRadius: 12, overflow: "hidden" },
});
