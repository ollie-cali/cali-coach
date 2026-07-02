// CaliHome board link — BLE client matching the COMPILE-VERIFIED firmware_v2
// contract (maker-ollie-brain/models/handstand-board-v1, 2026-07-02).
// [Maker Ollie delivery — SCAFFOLD: uses react-native-ble-plx; verify its API
// against the installed version. The UUID CONTRACT below is the stable part.]
//
// The fusion product: camera scores the BODY (alignment), the board scores the
// BASE (stability + hold detect + spirit level). Merge by timestamp:
//   "26 s hold · board stability 88 · alignment 91 · fix: open shoulders"

export const CALIBOARD = {
  name: "CaliBoard",
  SVC:      "ca110000-0000-1000-8000-00805f9b34fb",
  CH_STATE: "ca110001-0000-1000-8000-00805f9b34fb", // notify: IDLE/HOLDING/RESTING
  CH_HOLD:  "ca110002-0000-1000-8000-00805f9b34fb", // notify: live secs, then {"secs","stab"} at hold end
  CH_REC:   "ca110003-0000-1000-8000-00805f9b34fb", // notify: START/STOP (the board's record button)
  CH_BATT:  "ca110004-0000-1000-8000-00805f9b34fb", // notify: battery %
  CH_CMD:   "ca110005-0000-1000-8000-00805f9b34fb", // write: "BUZZ" | "TARE"
  CH_TILT:  "ca110006-0000-1000-8000-00805f9b34fb", // notify: spirit-level deg x100
} as const;

export interface BoardHold { secs: number; stab: number }        // hold-end payload
export interface BoardEvents {
  onState?: (s: string) => void;
  onLiveSecs?: (secs: number) => void;
  onHoldEnd?: (h: BoardHold) => void;      // fuse with the camera session here
  onRecord?: (start: boolean) => void;     // board button pressed -> start/stop filming
  onBattery?: (pct: number) => void;
  onTilt?: (deg: number) => void;          // spirit level while idle
}

/* Wiring sketch (react-native-ble-plx):

import { BleManager } from "react-native-ble-plx";
import { Buffer } from "buffer";

export async function connectCaliBoard(mgr: BleManager, ev: BoardEvents) {
  const device = await new Promise((resolve, reject) => {
    mgr.startDeviceScan([CALIBOARD.SVC], null, (err, d) => {
      if (err) return reject(err);
      if (d?.name === CALIBOARD.name) { mgr.stopDeviceScan(); resolve(d); }
    });
  });
  const dev = await device.connect();
  await dev.discoverAllServicesAndCharacteristics();
  const txt = (c) => Buffer.from(c.value, "base64").toString();
  const sub = (uuid, fn) => dev.monitorCharacteristicForService(CALIBOARD.SVC, uuid, (e, c) => c && fn(txt(c)));

  sub(CALIBOARD.CH_STATE, v => ev.onState?.(v));
  sub(CALIBOARD.CH_HOLD,  v => v.startsWith("{") ? ev.onHoldEnd?.(JSON.parse(v)) : ev.onLiveSecs?.(+v));
  sub(CALIBOARD.CH_REC,   v => ev.onRecord?.(v === "START"));
  sub(CALIBOARD.CH_BATT,  v => ev.onBattery?.(+v));
  sub(CALIBOARD.CH_TILT,  v => ev.onTilt?.(+v / 100));
  return {
    buzz: () => dev.writeCharacteristicWithResponseForService(
      CALIBOARD.SVC, CALIBOARD.CH_CMD, Buffer.from("BUZZ").toString("base64")),
    disconnect: () => dev.cancelConnection(),
  };
}

Fusion rule (in the session layer): when a camera hold and a board hold end within
±2 s of each other, write ONE coach_sessions row with source='fused',
board_stability = hold.stab, avg_score = camera alignment avg.
The board's onRecord=true should start the camera capture (that button flow is
already in firmware_v2, compile-verified).
*/
