import { ALPHA_TEXTS } from "@bf-migrate/core";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useAlphaStore, type AlphaStep } from "../src/stores/alpha";

describe("Alpha Migrate's opening confirmation", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps every other step closed until it is ticked", () => {
    const alpha = useAlphaStore();
    const later: AlphaStep[] = ["variant", "wiring", "probe", "confirm-chip", "report", "firmware", "unlock", "write", "done"];
    for (const step of later) {
      alpha.goTo(step);
      expect(alpha.step, step).toBe("intro");
    }
    // The migrated board's "Rewrite it over SWD" button goes through here too.
    alpha.chooseBoard("analog");
    expect(alpha.step).toBe("intro");
    expect(alpha.acknowledged).toBe(false);
    expect(alpha.confirmations).toEqual([]);
  });

  it("is recorded once, and then the board choice comes first", () => {
    const alpha = useAlphaStore();
    alpha.acknowledge();
    expect(alpha.step).toBe("variant");
    // Reading the intro again and going on does not record it twice.
    alpha.goTo("intro");
    expect(alpha.step).toBe("intro");
    alpha.acknowledge();
    expect(alpha.step).toBe("variant");
    expect(alpha.confirmations.map((entry) => [entry.id, entry.version])).toEqual([[ALPHA_TEXTS.intro.id, ALPHA_TEXTS.intro.version]]);
    alpha.goTo("firmware");
    expect(alpha.step).toBe("firmware");
  });

  it("stands after Start over, which returns to the board choice and keeps it for the report", async () => {
    const alpha = useAlphaStore();
    alpha.acknowledge();
    alpha.chooseBoard("analog");
    expect(alpha.step).toBe("wiring");
    alpha.confirm("wiring");
    await alpha.reset();
    expect(alpha.step).toBe("variant");
    expect(alpha.boardId).toBe("hd");
    expect(alpha.acknowledged).toBe(true);
    expect(alpha.confirmations.map((entry) => entry.id)).toEqual([ALPHA_TEXTS.intro.id]);
  });
});
