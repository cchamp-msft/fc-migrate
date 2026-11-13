import { releaseLineOf } from "../migrate/rules.js";
import type { FirmwareRelease } from "./build-api.js";

function parseVersion(version: string): { numbers: number[]; prerelease: string } {
  const [core = "", ...rest] = version.split("-");
  return { numbers: core.split(".").map(Number), prerelease: rest.join("-") };
}

/** Orders firmware versions numerically. A pre-release sorts before its own final release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

/**
 * Releases a board can move to: anything newer than it runs, on a line migration
 * understands, and the release it runs now, which rebuilds it (for example with other
 * build options) and sends its settings back.
 */
export function upgradeTargets(current: string, releases: readonly FirmwareRelease[], includeUnstable: boolean): FirmwareRelease[] {
  return releases.filter((release) => {
    const order = compareVersions(release.release, current);
    return releaseLineOf(release.release) && order >= 0 && (order === 0 || includeUnstable || release.type === "Stable");
  });
}
