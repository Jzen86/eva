import { describe, it, expect } from "vitest";
import { buildWorkflow, sizeFor, cloudSizeFor, COMFY_UNET, FORMATS } from "../../src/core/comfy.js";

describe("buildWorkflow", () => {
  it("builds a text-only graph with no reference node", () => {
    const g = buildWorkflow({ prompt: "a cafe", seed: 1 });
    expect(g["1"].inputs.unet_name).toBe(COMFY_UNET);
    expect(g["6"]).toBeUndefined();
    expect(g["5"].class_type).toBe("TextEncodeQwenImage21");
    expect(g["5"].inputs.prompt).toBe("a cafe");
    expect(g["7"].inputs.negative).toEqual(["5", 1]);
    expect(g["10"].inputs.filename_prefix).toBe("eva/img");
  });

  it("edits the reference through EditPlus, which is what keeps the face", () => {
    // The 21-encoder drops the reference's vision tokens the moment a reference
    // latent is present, and a long figure description then overrides the face.
    // EditPlus keeps both vision and latents, so the text edits the reference
    // instead of replacing her. Measured on the live reference, one seed per row:
    // EditPlus kept her face on 4 of 4 seeds; the 21-encoder drew a different
    // woman on 2 of them, both times with the body text in the prompt.
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "eva_ref.jpg", filenamePrefix: "eva/selfie" });
    expect(g["6"]).toEqual({ class_type: "LoadImage", inputs: { image: "eva_ref.jpg" } });
    expect(g["5"].class_type).toBe("TextEncodeQwenImageEditPlus");
    expect(g["5"].inputs.image1).toEqual(["6", 0]);
    expect(g["7"].inputs.negative).toEqual(["5", 0]);
    expect(g["10"].inputs.filename_prefix).toBe("eva/selfie");
  });

  it("never reuses the owner's custom nodes", () => {
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "r.jpg" });
    const classes = Object.values(g).map((n) => n.class_type);
    expect(classes.some((c) => /JzenReference|JzenResolution|StringConcatenate/.test(c))).toBe(false);
  });

  it("sizes the frame from an empty latent, 1024 by default", () => {
    // The encoder's own latent output is the *reference's* size (square), so it
    // would pin every frame to 1:1 and ignore the requested ratio. The empty
    // latent is what decides the frame.
    const g = buildWorkflow({ prompt: "x", seed: 1 });
    expect(g["9"].class_type).toBe("EmptyLatentImage");
    expect(g["9"].inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(g["7"].inputs.latent_image).toEqual(["9", 0]);
    expect(g["5"].inputs.resolution).toBe(1024);
  });

  it("renders every format from the requested size", () => {
    const portrait = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("3:4") });
    expect(portrait["9"].inputs).toMatchObject({ width: 1024, height: 1376 });
    const landscape = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("4:3") });
    expect(landscape["9"].inputs).toMatchObject({ width: 1376, height: 1024 });
    // Every frame on the same 1024 short side, every side a multiple of 32.
    expect(sizeFor("4:5")).toEqual({ width: 1024, height: 1280 });
    expect(sizeFor("9:16")).toEqual({ width: 1024, height: 1824 });
    // The tallest frame, for a full body that should fill the shot.
    expect(sizeFor("2:3")).toEqual({ width: 1024, height: 1536 });
  });

  it("falls back to 1:1 on an unknown format", () => {
    expect(sizeFor("16:9")).toEqual(FORMATS["1:1"]);
    expect(sizeFor(undefined)).toEqual(FORMATS["1:1"]);
  });

  it("sends the cloud a size its endpoints accept", () => {
    expect(cloudSizeFor(sizeFor("1:1"))).toBe("1024x1024");
    expect(cloudSizeFor(sizeFor("2:3"))).toBe("1024x1536");
    expect(cloudSizeFor(sizeFor("9:16"))).toBe("1024x1536");
    expect(cloudSizeFor(sizeFor("3:4"))).toBe("1024x1536");
    expect(cloudSizeFor(sizeFor("4:5"))).toBe("1024x1536");
    expect(cloudSizeFor(sizeFor("4:3"))).toBe("1536x1024");
  });
});
