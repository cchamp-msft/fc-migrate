import { describe, expect, it } from "vitest";
import { BuildApi, BuildServiceError, selectBuildOptions, type BuildOptionCatalog } from "../src/firmware/build-api.js";

const catalog: BuildOptionCatalog = {
  radioProtocols: [{ name: "CRSF", value: "USE_SERIALRX_CRSF" }],
  telemetryProtocols: [{ name: "None", value: "" }, { name: "SmartPort", value: "USE_TELEMETRY_SMARTPORT" }],
  motorProtocols: [{ name: "DShot", value: "USE_DSHOT" }],
  generalOptions: [{ name: "VTX", value: "USE_VTX" }],
};

function respond(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("build option selection", () => {
  it("keeps what the release offers and reports the rest", () => {
    const selection = selectBuildOptions(["USE_SERIALRX_CRSF", "USE_DSHOT", "USE_VTX", "USE_RACE_PRO"], catalog);
    expect(selection.options).toEqual(["CLOUD_BUILD", "USE_SERIALRX_CRSF", "USE_DSHOT", "USE_VTX"]);
    expect(selection.unavailable).toEqual(["USE_RACE_PRO"]);
  });
});

describe("build service client", () => {
  it("hides withdrawn releases", async () => {
    const api = new BuildApi("https://x", async () => respond({ releases: [{ release: "1", label: "a", type: "Stable" }, { release: "2", label: "b", type: "Stable", withdrawn: true }] }));
    expect((await api.listReleases("RRIOT_F722")).map((release) => release.release)).toEqual(["1"]);
  });

  it("posts the build request as JSON", async () => {
    let sent: RequestInit | undefined;
    const api = new BuildApi("https://x", async (_url, init) => {
      sent = init;
      return respond({ key: "k", url: "/f", file: "f.hex" });
    });
    await expect(api.requestBuild({ target: "T", release: "R", options: ["CLOUD_BUILD"] })).resolves.toMatchObject({ key: "k" });
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(String(sent?.body))).toEqual({ target: "T", release: "R", options: ["CLOUD_BUILD"] });
  });

  it("reports a failed build", async () => {
    const api = new BuildApi("https://x", async () => respond({ status: "failed" }));
    await expect(api.waitForBuild("k")).rejects.toBeInstanceOf(BuildServiceError);
  });

  it("surfaces HTTP errors", async () => {
    const api = new BuildApi("https://x", async () => respond("nope", 500));
    await expect(api.getOptions("R")).rejects.toThrow(/HTTP 500/);
  });
});
