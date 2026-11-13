/**
 * Asks real firmware to compute PIDs from changed sliders and compares them with the
 * 4.5 values converted by the migrator. Nothing is saved: leaving the CLI discards it.
 */
import { convertD, pidsFromSliders45, type Sliders } from "@bf-migrate/core";
import { connect, release } from "./connect.js";

const connection = await connect(process.argv[2] ?? "COM6");
console.log(`Checking sliders on ${connection.identity.firmwareVersion}`);
const { cli } = connection.link;
await cli.enter();

const cases: Partial<Sliders>[] = [{ d: 120 }, { master: 90, d: 110, dMax: 50 }, { pi: 130, i: 80, feedforward: 70, pitchD: 110, pitchPi: 105 }];
const BASE: Sliders = { master: 100, i: 100, d: 100, pi: 100, dMax: 100, feedforward: 100, pitchD: 100, pitchPi: 100 };
const NAMES: Record<keyof Sliders, string> = {
  master: "simplified_master_multiplier",
  i: "simplified_i_gain",
  d: "simplified_d_gain",
  pi: "simplified_pi_gain",
  dMax: "simplified_d_max_gain",
  feedforward: "simplified_feedforward_gain",
  pitchD: "simplified_pitch_d_gain",
  pitchPi: "simplified_pitch_pi_gain",
};

async function read(name: string): Promise<number> {
  const { output } = await cli.runQuietly(`get ${name}`);
  const match = new RegExp(`^${name} = (-?\\d+)`, "m").exec(output);
  if (!match) throw new Error(`Could not read ${name}: ${output}`);
  return Number(match[1]);
}

let failures = 0;
for (const change of cases) {
  const sliders = { ...BASE, ...change };
  for (const [key, name] of Object.entries(NAMES)) {
    const result = await cli.runQuietly(`set ${name} = ${sliders[key as keyof Sliders]}`);
    if (result.errors.length) throw new Error(result.errors.join("; "));
  }
  await cli.runQuietly("simplified_tuning apply");

  const old = pidsFromSliders45(sliders, ["roll", "pitch", "yaw"]);
  for (const axis of ["roll", "pitch", "yaw"] as const) {
    const expected = old[axis]!;
    const convertedD = convertD(expected.d, expected.dMin);
    const expectedValues: Record<string, number> = { [`p_${axis}`]: expected.p, [`i_${axis}`]: expected.i, [`f_${axis}`]: expected.f, [`d_${axis}`]: convertedD.d, [`d_max_${axis}`]: convertedD.dMax };
    for (const [name, value] of Object.entries(expectedValues)) {
      const actual = await read(name);
      const ok = Math.abs(actual - value) <= 1;
      if (!ok) failures++;
      if (!ok || actual !== value) console.log(`  ${ok ? "off by one" : "MISMATCH"} ${JSON.stringify(change)} ${name}: 4.5 converted ${value}, firmware ${actual}`);
    }
  }
  console.log(`Checked ${JSON.stringify(change)}`);
}

console.log(failures === 0 ? "All slider cases agree with the converted 4.5 values." : `${failures} values disagree.`);
await release(connection, true);
process.exit(failures === 0 ? 0 : 2);
