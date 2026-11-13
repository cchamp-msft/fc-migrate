const DEFAULT_BASE_URL = "https://build.betaflight.com";
const POLL_INTERVAL_MS = 4000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
/** Identifies this client honestly to the build service. */
const CLIENT_VERSION = "bf-migrate-0.1.0";

export interface FirmwareRelease {
  release: string;
  label: string;
  type: string;
  withdrawn?: boolean;
}

export interface BuildOptionChoice {
  name: string;
  value: string;
  default?: boolean;
}

export interface BuildOptionCatalog {
  radioProtocols: BuildOptionChoice[];
  telemetryProtocols: BuildOptionChoice[];
  motorProtocols: BuildOptionChoice[];
  generalOptions: BuildOptionChoice[];
}

export interface BuildRequest {
  target: string;
  release: string;
  options: string[];
}

export interface BuildTicket {
  key: string;
  url: string;
  file: string;
}

export type BuildState = "queued" | "building" | "success" | "failed" | (string & {});

export class BuildServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildServiceError";
  }
}

export interface BuildOptionSelection {
  options: string[];
  /** Options the board has that this release does not offer. */
  unavailable: string[];
}

/**
 * Chooses the build options for a new firmware so it matches what the board runs now.
 * The build service takes only one radio and one telemetry protocol at a time in some
 * releases, but cloud builds accept the full list of defines.
 */
export function selectBuildOptions(boardDefines: readonly string[], catalog: BuildOptionCatalog): BuildOptionSelection {
  const offered = new Set([...catalog.radioProtocols, ...catalog.telemetryProtocols, ...catalog.motorProtocols, ...catalog.generalOptions].map((choice) => choice.value).filter(Boolean));
  const options = ["CLOUD_BUILD"];
  const unavailable: string[] = [];
  for (const define of boardDefines) {
    if (offered.has(define)) options.push(define);
    else unavailable.push(define);
  }
  return { options, unavailable };
}

/** Client for Betaflight's public cloud build service. */
export class BuildApi {
  constructor(
    private readonly baseUrl = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async listReleases(target: string): Promise<FirmwareRelease[]> {
    const body = await this.getJson<{ releases: FirmwareRelease[] }>(`/api/targets/${encodeURIComponent(target)}`);
    return body.releases.filter((release) => !release.withdrawn);
  }

  getOptions(release: string): Promise<BuildOptionCatalog> {
    return this.getJson(`/api/options/${encodeURIComponent(release)}`);
  }

  async requestBuild(request: BuildRequest): Promise<BuildTicket> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFG-VER": CLIENT_VERSION },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new BuildServiceError(`The build service refused the request (HTTP ${response.status}).`);
    return (await response.json()) as BuildTicket;
  }

  async buildStatus(key: string): Promise<BuildState> {
    const body = await this.getJson<{ status: BuildState }>(`/api/builds/${encodeURIComponent(key)}/status`);
    return body.status;
  }

  /** Polls until the build finishes. Resolves when the firmware is ready to download. */
  async waitForBuild(key: string, onStatus?: (state: BuildState) => void, timeoutMs = BUILD_TIMEOUT_MS): Promise<void> {
    const started = Date.now();
    for (;;) {
      const state = await this.buildStatus(key);
      onStatus?.(state);
      if (state === "success") return;
      if (state !== "queued" && state !== "building" && state !== "running" && state !== "pending") {
        throw new BuildServiceError(`The firmware build ended with status "${state}".`);
      }
      if (Date.now() - started > timeoutMs) throw new BuildServiceError("Timed out waiting for the firmware build.");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async downloadFirmware(path: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { "X-CFG-VER": CLIENT_VERSION } });
    if (!response.ok) throw new BuildServiceError(`Could not download the firmware (HTTP ${response.status}).`);
    return response.text();
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { "X-CFG-VER": CLIENT_VERSION } });
    if (!response.ok) throw new BuildServiceError(`The build service returned HTTP ${response.status} for ${path}.`);
    return (await response.json()) as T;
  }
}
