import type { FirmwareSchema } from "@bf-migrate/core";

const modules = import.meta.glob<{ default: FirmwareSchema }>("../../../../data/schemas/*.json");

/** Loads the bundled schema for a firmware version, when one has been captured. */
export async function loadSchema(version: string): Promise<FirmwareSchema | undefined> {
  const entry = Object.entries(modules).find(([path]) => path.endsWith(`/${version}.json`));
  if (!entry) return undefined;
  return (await entry[1]()).default;
}
