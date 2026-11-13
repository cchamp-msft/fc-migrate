import { cleanCapturedCli, type SimulatedFcProfile } from "@bf-migrate/core/testing";
import identity from "../../../../fixtures/RRIOT_F722-4.5.4/identity.json";
import diffAll from "../../../../fixtures/RRIOT_F722-4.5.4/diff_all.txt?raw";
import dumpAll from "../../../../fixtures/RRIOT_F722-4.5.4/dump_all.txt?raw";
import featureOutput from "../../../../fixtures/RRIOT_F722-4.5.4/feature.txt?raw";
import getAll from "../../../../fixtures/RRIOT_F722-4.5.4/get_all.txt?raw";
import help from "../../../../fixtures/RRIOT_F722-4.5.4/help.txt?raw";
import status from "../../../../fixtures/RRIOT_F722-4.5.4/status.txt?raw";
import version from "../../../../fixtures/RRIOT_F722-4.5.4/version.txt?raw";

/** Replays captures from a real RRIOT F722 so the app can be explored without a board. */
export const demoProfile: SimulatedFcProfile = {
  ...identity,
  cli: {
    version: cleanCapturedCli(version),
    status: cleanCapturedCli(status),
    help: cleanCapturedCli(help),
    get: cleanCapturedCli(getAll),
    feature: cleanCapturedCli(featureOutput),
    "diff all": cleanCapturedCli(diffAll),
    "dump all": cleanCapturedCli(dumpAll),
  },
};
