import { describe, it, expect } from "vitest";
import { buildWorkflow, COMFY_UNET } from "../../src/core/comfy.js";

describe("buildWorkflow", () => {
  it("builds a text-only graph with no reference node", () => {
    const g = buildWorkflow({ prompt: "a cafe", seed: 1 });
    expect(g["1"].inputs.unet_name).toBe(COMFY_UNET);
    expect(g["6"]).toBeUndefined();
    expect(g["5"].inputs.images).toEqual({});
    expect(g["5"].inputs.prompt).toBe("a cafe");
    expect(g["9"].inputs.filename_prefix).toBe("eva/img");
  });

  it("wires the uploaded reference into image_1", () => {
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "eva_ref.jpg", filenamePrefix: "eva/selfie" });
    expect(g["6"]).toEqual({ class_type: "LoadImage", inputs: { image: "eva_ref.jpg" } });
    expect(g["5"].inputs.images).toEqual({ image_1: ["6", 0] });
    expect(g["9"].inputs.filename_prefix).toBe("eva/selfie");
  });

  it("never reuses the owner's custom nodes", () => {
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "r.jpg" });
    const classes = Object.values(g).map((n) => n.class_type);
    expect(classes.some((c) => /JzenReference|JzenResolution|StringConcatenate/.test(c))).toBe(false);
  });
});
