import { describe, it, expect } from "vitest";
import { buildWorkflow, sizeFor, COMFY_UNET, FORMATS } from "../../src/core/comfy.js";

describe("buildWorkflow", () => {
  it("builds a text-only graph with no reference node", () => {
    const g = buildWorkflow({ prompt: "a cafe", seed: 1 });
    expect(g["1"].inputs.unet_name).toBe(COMFY_UNET);
    expect(g["6"]).toBeUndefined();
    expect(g["5"].inputs["images.image_1"]).toBeUndefined();
    expect(g["5"].inputs.prompt).toBe("a cafe");
    expect(g["10"].inputs.filename_prefix).toBe("eva/img");
  });

  it("wires the reference as a flat autogrow key, never as a nested object", () => {
    // ComfyUI accepts the nested form `images: { image_1: … }` silently and then
    // ignores it, so the job succeeds and the face comes out a stranger's. The
    // flat key is the one TextEncodeQwenImage21 actually reads — measured side by
    // side on one seed: nested → a different woman, flat → the reference's face.
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "eva_ref.jpg", filenamePrefix: "eva/selfie" });
    expect(g["6"]).toEqual({ class_type: "LoadImage", inputs: { image: "eva_ref.jpg" } });
    expect(g["5"].inputs["images.image_1"]).toEqual(["6", 0]);
    expect(g["5"].inputs.images).toBeUndefined();
    expect(g["10"].inputs.filename_prefix).toBe("eva/selfie");
  });

  it("never reuses the owner's custom nodes", () => {
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "r.jpg" });
    const classes = Object.values(g).map((n) => n.class_type);
    expect(classes.some((c) => /JzenReference|JzenResolution|StringConcatenate/.test(c))).toBe(false);
  });

  it("sizes the frame from an empty latent, 768 by default", () => {
    // The node's own latent output is the *reference's* size (square), so it would
    // pin every frame to 1:1 and ignore the requested ratio. The empty latent is
    // what decides the frame.
    const g = buildWorkflow({ prompt: "x", seed: 1 });
    expect(g["9"].class_type).toBe("EmptyLatentImage");
    expect(g["9"].inputs).toMatchObject({ width: 768, height: 768 });
    expect(g["7"].inputs.latent_image).toEqual(["9", 0]);
    expect(g["5"].inputs.resolution).toBe(768);
  });

  it("renders 3:4 and 4:3 from the requested size", () => {
    const portrait = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("3:4") });
    expect(portrait["9"].inputs).toMatchObject({ width: 768, height: 1024 });
    const landscape = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("4:3") });
    expect(landscape["9"].inputs).toMatchObject({ width: 1024, height: 768 });
  });

  it("falls back to 1:1 on an unknown format", () => {
    expect(sizeFor("16:9")).toEqual(FORMATS["1:1"]);
    expect(sizeFor(undefined)).toEqual(FORMATS["1:1"]);
  });
});
