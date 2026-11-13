/** Which part of the firmware configuration a line applies to. */
export type ConfigScope = { kind: "master" } | { kind: "profile"; index: number } | { kind: "rateprofile"; index: number } | { kind: "battery_profile"; index: number };

export interface SetLine {
  kind: "set";
  name: string;
  value: string;
  scope: ConfigScope;
  raw: string;
  lineNumber: number;
}

export interface CommandLine {
  kind: "command";
  command: string;
  args: string[];
  scope: ConfigScope;
  raw: string;
  lineNumber: number;
}

export type ConfigEntry = SetLine | CommandLine;

export interface ConfigMetadata {
  firmware?: string;
  firmwareVersion?: string;
  buildDate?: string;
  gitRevision?: string;
  mspApi?: string;
  configRevision?: string;
  boardName?: string;
  manufacturerId?: string;
  mcuId?: string;
  craftName?: string;
  /** PID profile selected on the board: the last one a dump switches to. */
  activeProfile?: number;
  activeRateProfile?: number;
}

export interface ConfigDocument {
  metadata: ConfigMetadata;
  entries: ConfigEntry[];
}

const VERSION_LINE = /^#\s*(\w+)\s*\/\s*(\S+)\s*\((\w+)\)\s+(\S+)\s+(.+?)\s*\/\s*(\S+)\s*\(([^)]*)\)(?:\s+MSP API:\s*(\S+))?/;
const CONFIG_REV_LINE = /^#\s*config rev:\s*(\S+)/;
const NAME_LINE = /^#\s*name:\s*(.*)$/;
const SET_LINE = /^set\s+([^\s=]+)\s*=\s*(.*)$/i;

const SCOPE_COMMANDS: Record<string, "profile" | "rateprofile" | "battery_profile"> = {
  profile: "profile",
  rateprofile: "rateprofile",
  battery_profile: "battery_profile",
};

/** Bookkeeping commands from a dump that carry no configuration of their own. */
const CONTROL_COMMANDS = new Set(["batch", "defaults", "save", "diff", "dump"]);

/** Parses `diff`, `diff all` or `dump all` output into structured entries. */
export function parseConfig(text: string): ConfigDocument {
  const metadata: ConfigMetadata = {};
  const entries: ConfigEntry[] = [];
  let scope: ConfigScope = { kind: "master" };

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const lineNumber = index + 1;
    if (!line) return;

    if (line.startsWith("#")) {
      readMetadataComment(line, metadata);
      return;
    }

    const setMatch = SET_LINE.exec(line);
    if (setMatch) {
      entries.push({ kind: "set", name: setMatch[1]!.toLowerCase(), value: setMatch[2]!.trim(), scope, raw: line, lineNumber });
      return;
    }

    const [command = "", ...args] = line.split(/\s+/);
    const lowered = command.toLowerCase();

    const scopeKind = SCOPE_COMMANDS[lowered];
    if (scopeKind && args.length === 1) {
      const index = Number(args[0]);
      scope = { kind: scopeKind, index };
      if (scopeKind === "profile") metadata.activeProfile = index;
      if (scopeKind === "rateprofile") metadata.activeRateProfile = index;
      return;
    }

    if (lowered === "board_name") metadata.boardName = args[0];
    if (lowered === "manufacturer_id") metadata.manufacturerId = args[0];
    if (lowered === "mcu_id") metadata.mcuId = args[0];
    if (CONTROL_COMMANDS.has(lowered)) return;

    entries.push({ kind: "command", command: lowered, args, scope: { kind: "master" }, raw: line, lineNumber });
  });

  return { metadata, entries };
}

function readMetadataComment(line: string, metadata: ConfigMetadata): void {
  const version = VERSION_LINE.exec(line);
  if (version) {
    metadata.firmware = version[1];
    metadata.firmwareVersion = version[4];
    metadata.buildDate = `${version[5]} ${version[6]}`;
    metadata.gitRevision = version[7];
    metadata.mspApi = version[8];
    return;
  }
  const configRev = CONFIG_REV_LINE.exec(line);
  if (configRev) {
    metadata.configRevision = configRev[1];
    return;
  }
  const name = NAME_LINE.exec(line);
  if (name) metadata.craftName = name[1]!.trim();
}

export function scopeKey(scope: ConfigScope): string {
  return scope.kind === "master" ? "master" : `${scope.kind}:${scope.index}`;
}

export function setEntries(document: ConfigDocument): SetLine[] {
  return document.entries.filter((entry): entry is SetLine => entry.kind === "set");
}

export function commandEntries(document: ConfigDocument, command?: string): CommandLine[] {
  return document.entries.filter((entry): entry is CommandLine => entry.kind === "command" && (command === undefined || entry.command === command));
}
