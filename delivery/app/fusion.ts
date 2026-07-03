// Camera + board fusion — the metric nobody else has:
// "26 s hold · body alignment 91 (camera) · base stability 88 (board)".
// Pure function, testable headlessly (test/fusion.test.mjs). [Maker Ollie]
//
// Rule: a camera handstand entry and a board hold FUSE when their end times land
// within WINDOW_MS of each other and their durations agree within DUR_TOL (the
// same physical hold seen by two sensors). Unmatched entries pass through as-is.

export interface CameraHold { type: "handstand"; secs: number; avg: number; min: number; at: string; [k: string]: unknown }
export interface BoardHold { secs: number; stab: number; endedAtMs: number }
export interface FusedHold extends CameraHold { boardStability?: number; source: "camera" | "fused" }

export const WINDOW_MS = 2000, DUR_TOL = 0.35;   // 35% duration agreement

export function fuseHolds(camera: CameraHold[], board: BoardHold[],
                          cameraEndMs: (e: CameraHold) => number): FusedHold[] {
  const used = new Set<number>();
  return camera.map(e => {
    if (e.type !== "handstand") return { ...e, source: "camera" as const };
    const end = cameraEndMs(e);
    let best = -1, bestDt = Infinity;
    board.forEach((b, i) => {
      if (used.has(i)) return;
      const dt = Math.abs(b.endedAtMs - end);
      const durOk = Math.abs(b.secs - e.secs) <= DUR_TOL * Math.max(e.secs, b.secs);
      if (dt <= WINDOW_MS && durOk && dt < bestDt) { best = i; bestDt = dt; }
    });
    if (best >= 0) { used.add(best); return { ...e, boardStability: board[best].stab, source: "fused" as const }; }
    return { ...e, source: "camera" as const };
  });
}
