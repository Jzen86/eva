import { describe, it, expect } from "vitest";
import { FORMATS, formatList, sizeFor, type AspectFormat } from "../../src/core/comfy.js";
import { SelfieTool } from "../../src/core/tools/selfie.js";
import { ImageGenTool } from "../../src/core/tools/image-gen.js";

/**
 * The formats are written once, in the table.
 *
 * Twice this promise broke the same way. First the tools promised three formats
 * while the table held six (`619cbc1`); then, after the frames moved to a 1024
 * short side and 9:16 took 5:4's place, the descriptions kept offering
 * "5:4 (альбом)" and never mentioned 9:16 at all. `resolveFormat` asks the
 * table, so a request for 5:4 fell silently back to the default frame, and
 * nobody asked for 9:16 because nothing said it existed. Eva found that one by
 * reading the file — and then proposed to fix it by hand, which is how the
 * second copy appears in the first place.
 *
 * So these tests do not compare the list to a copy: there is no copy. They hold
 * the mechanism — the phrase comes from the table, the tools use the phrase, and
 * a format that leaves the table leaves the descriptions with it.
 */

const selfie = () =>
  new SelfieTool({ openrouterApiKey: "k", referencePhotoUrl: "https://example.com/p.jpg" });
const imageGen = () => new ImageGenTool({ apiKey: "k" });

/** Everything the two image tools tell the model about frames. */
function whatTheToolsSay(): string {
  const s = selfie();
  const g = imageGen();
  return [
    s.description,
    ...s.parameters.map((p) => p.description),
    g.description,
    ...g.parameters.map((p) => p.description),
  ].join("\n");
}

describe("the format list", () => {
  const keys = Object.keys(FORMATS) as AspectFormat[];

  it("names every format in the table, and every one has a word", () => {
    for (const key of keys) {
      expect(formatList()).toContain(key);
      // A format cannot arrive half-written: the phrase is built from these.
      expect(FORMATS[key].label.length).toBeGreaterThan(0);
    }
  });

  it("is exactly what the tools say", () => {
    expect(whatTheToolsSay()).toContain(formatList());
  });

  it("does not promise a format the table has dropped", () => {
    // 5:4 left when 9:16 took its place. The descriptions kept offering it, and
    // the tool quietly answered with the default frame instead.
    expect(whatTheToolsSay()).not.toContain("5:4");
    expect(formatList()).not.toContain("5:4");
  });

  it("keeps sizeFor to the two numbers", () => {
    // It gets spread into the graph, so a label riding along would be a stray
    // field inside a workflow node.
    expect(Object.keys(sizeFor("9:16")).sort()).toEqual(["height", "width"]);
  });
});
