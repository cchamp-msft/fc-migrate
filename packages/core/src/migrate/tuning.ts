import type { SliderFit } from "./types.js";

export const AXES = ["roll", "pitch", "yaw"] as const;
export type Axis = (typeof AXES)[number];

export interface AxisPid {
  p: number;
  i: number;
  /** Peak D on 4.5. */
  d: number;
  f: number;
  /** Base D on 4.5. */
  dMin: number;
}

export type PidSet = Record<Axis, AxisPid>;

export interface Sliders {
  master: number;
  i: number;
  d: number;
  pi: number;
  dMax: number;
  feedforward: number;
  pitchD: number;
  pitchPi: number;
}

/** Factory values on 4.5.x. */
export const BASE_45: PidSet = {
  roll: { p: 45, i: 80, d: 40, f: 120, dMin: 30 },
  pitch: { p: 47, i: 84, d: 46, f: 125, dMin: 34 },
  yaw: { p: 45, i: 80, d: 0, f: 120, dMin: 0 },
};

const PID_GAIN_MAX = 250;
const F_GAIN_MAX = 1000;

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

/** The firmware's slider calculation on 4.5.x, for the axes the slider mode covers. */
export function pidsFromSliders45(sliders: Sliders, axes: readonly Axis[]): Partial<PidSet> {
  const result: Partial<PidSet> = {};
  const master = sliders.master / 100;
  const pi = sliders.pi / 100;
  const dGain = sliders.d / 100;
  const ff = sliders.feedforward / 100;
  const iGain = sliders.i / 100;

  for (const axis of axes) {
    const base = BASE_45[axis];
    const pitchD = axis === "pitch" ? sliders.pitchD / 100 : 1;
    const pitchPi = axis === "pitch" ? sliders.pitchPi / 100 : 1;
    const ratio = base.dMin > 0 ? 1 + ((base.d - base.dMin) / base.dMin) * (sliders.dMax / 100) : 1;
    result[axis] = {
      p: clamp(base.p * master * pi * pitchPi, PID_GAIN_MAX),
      i: clamp(base.i * master * pi * iGain * pitchPi, PID_GAIN_MAX),
      d: clamp(base.dMin * master * dGain * pitchD * ratio, PID_GAIN_MAX),
      dMin: clamp(base.dMin * master * dGain * pitchD, PID_GAIN_MAX),
      f: clamp(base.f * master * pitchPi * ff, F_GAIN_MAX),
    };
  }
  return result;
}

/** Tolerance in PID units: the firmware truncates, and a tune may have been saved on another build. */
const SLIDER_MATCH_TOLERANCE = 1;

export function matchesSliders(actual: PidSet, sliders: Sliders, axes: readonly Axis[]): boolean {
  const predicted = pidsFromSliders45(sliders, axes);
  return axes.every((axis) => {
    const expected = predicted[axis]!;
    const real = actual[axis];
    return (["p", "i", "d", "f", "dMin"] as const).every((key) => Math.abs(expected[key] - real[key]) <= SLIDER_MATCH_TOLERANCE);
  });
}

/**
 * Converts 4.5 D values to the 2025.12 meaning, where `d` is the base and
 * `d_max` the peak. When D boost was off on 4.5 it must be off explicitly on the
 * target: leaving `d_max` at its default would turn it on.
 */
export function convertD(d: number, dMin: number): { d: number; dMax: number } {
  if (dMin > 0 && dMin < d) return { d: dMin, dMax: d };
  return { d, dMax: 0 };
}

/** Advance was scaled by gain on 4.5. From 2025.12 it stands alone. */
export function convertDMaxAdvance(gain: number, advance: number): number {
  return Math.round((gain * advance) / 100);
}

/** Expresses a custom tune as sliders and reports how closely they reproduce it. */
export function fitSliders(actual: PidSet): SliderFit {
  const base = BASE_45;
  const round = (value: number) => Math.max(0, Math.min(200, Math.round(value / 5) * 5));

  const pi = round((actual.roll.p / base.roll.p) * 100);
  const i = pi > 0 ? round((actual.roll.i / base.roll.i / (pi / 100)) * 100) : 100;
  const dGain = round((actual.roll.dMin / base.roll.dMin) * 100);
  const feedforward = round((actual.roll.f / base.roll.f) * 100);
  const pitchPi = pi > 0 ? round((actual.pitch.p / base.pitch.p / (pi / 100)) * 100) : 100;
  const pitchD = dGain > 0 ? round((actual.pitch.dMin / base.pitch.dMin / (dGain / 100)) * 100) : 100;
  const peakShare = actual.roll.dMin > 0 ? (actual.roll.d / actual.roll.dMin - 1) / ((base.roll.d - base.roll.dMin) / base.roll.dMin) : 1;
  const dMax = round(peakShare * 100);

  const sliders: Sliders = { master: 100, i, d: dGain, pi, dMax, feedforward, pitchD, pitchPi };
  const predicted = pidsFromSliders45(sliders, AXES) as PidSet;

  let maxError = 0;
  for (const axis of AXES) {
    for (const key of ["p", "i", "d", "dMin", "f"] as const) {
      maxError = Math.max(maxError, Math.abs(predicted[axis][key] - actual[axis][key]));
    }
  }

  return {
    maxError,
    sliders: {
      simplified_master_multiplier: 100,
      simplified_pi_gain: pi,
      simplified_i_gain: i,
      simplified_d_gain: dGain,
      simplified_d_max_gain: dMax,
      simplified_feedforward_gain: feedforward,
      simplified_pitch_d_gain: pitchD,
      simplified_pitch_pi_gain: pitchPi,
    },
  };
}
