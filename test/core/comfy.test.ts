import { describe, it, expect } from "vitest";
import { buildWorkflow, sizeFor, cloudSizeFor, COMFY_UNET, TURBO_SIGMAS, FORMATS } from "../../src/core/comfy.js";

describe("buildWorkflow", () => {
  it("builds a text-only graph with no reference node", () => {
    const g = buildWorkflow({ prompt: "a cafe", seed: 1 });
    expect(g["1"].inputs.unet_name).toBe(COMFY_UNET);
    expect(g["6"]).toBeUndefined();
    expect(g["5"].class_type).toBe("TextEncodeQwenImage21");
    expect(g["5"].inputs.prompt).toBe("a cafe");
    expect(g["15"].inputs.negative).toEqual(["5", 1]);
    expect(g["12"].inputs.noise_seed).toBe(1);
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
    expect(g["15"].inputs.negative).toEqual(["5", 0]);
    expect(g["10"].inputs.filename_prefix).toBe("eva/selfie");
  });

  it("feeds a second reference into EditPlus through image2", () => {
    // A frame with both of them: image 1 is her, image 2 is the owner. Same
    // node, one more image — the prompt is what names which face is which, and
    // the graph stays the graph it was for a lone selfie.
    const g = buildWorkflow({
      prompt: "x",
      seed: 1,
      referenceName: "her.jpg",
      referenceName2: "owner.jpg",
      filenamePrefix: "eva/couple",
    });
    expect(g["6"]).toEqual({ class_type: "LoadImage", inputs: { image: "her.jpg" } });
    expect(g["11"]).toEqual({ class_type: "LoadImage", inputs: { image: "owner.jpg" } });
    expect(g["5"].class_type).toBe("TextEncodeQwenImageEditPlus");
    expect(g["5"].inputs.image1).toEqual(["6", 0]);
    expect(g["5"].inputs.image2).toEqual(["11", 0]);
    expect(g["15"].inputs.negative).toEqual(["5", 0]);
    expect(g["10"].inputs.filename_prefix).toBe("eva/couple");
  });

  it("never reuses the owner's custom nodes", () => {
    // The bot's graph has to stand on core nodes alone: it must not depend on the
    // owner's custom_nodes directory, or pulling a ComfyUI that dropped them would
    // take the pictures down with it. A schedule can be handed over as a value on
    // core nodes, so nothing here needs ours.
    const g = buildWorkflow({ prompt: "x", seed: 1, referenceName: "r.jpg" });
    const classes = Object.values(g).map((n) => n.class_type);
    expect(classes.some((c) => /^Jzen/.test(c))).toBe(false);
  });

  it("samples on the schedule Turbo was distilled on, one for both paths", () => {
    // The KSampler used to be told "8 steps" and a scheduler name — a guess at the
    // schedule. The schedule Turbo actually learned is this list, handed over as a
    // value.
    const g = buildWorkflow({ prompt: "x", seed: 1 });
    expect(g["14"]).toEqual({ class_type: "ManualSigmas", inputs: { sigmas: TURBO_SIGMAS } });
    expect(g["13"]).toEqual({ class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } });
    expect(g["7"].class_type).toBe("SamplerCustomAdvanced");
    expect(g["15"].inputs.cfg).toBe(1);
    // A selfie and a plain picture take the same schedule now; the old graph
    // branched here, `simple` against `linear_quadratic`.
    const withRef = buildWorkflow({ prompt: "x", seed: 1, referenceName: "r.jpg" });
    expect(withRef["14"]).toEqual(g["14"]);
    expect(withRef["15"].inputs.cfg).toBe(1);
    // Nothing anywhere names a scheduler: the old guess is gone, not outvoted.
    expect(Object.values(g).some((n) => "scheduler" in n.inputs)).toBe(false);
  });

  it("sizes the frame from an empty latent, the 1:1 frame by default", () => {
    // The encoder's own latent output is the *reference's* size (square), so it
    // would pin every frame to 1:1 and ignore the requested ratio. The empty
    // latent is what decides the frame, and its default comes from the table — an
    // unset size must not quietly land outside the scheme.
    const g = buildWorkflow({ prompt: "x", seed: 1 });
    expect(g["9"].class_type).toBe("EmptyLatentImage");
    expect(g["9"].inputs).toMatchObject({ width: 896, height: 896 });
    expect(g["7"].inputs.latent_image).toEqual(["9", 0]);
    expect(g["5"].inputs.resolution).toBe(1024);
  });

  it("renders every format from the requested size", () => {
    // One long side, 896, and every side a multiple of 32: the ratio decides the
    // short side, the scheme decides the long one.
    const portrait = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("3:4") });
    expect(portrait["9"].inputs).toMatchObject({ width: 672, height: 896 });
    const landscape = buildWorkflow({ prompt: "x", seed: 1, ...sizeFor("4:3") });
    expect(landscape["9"].inputs).toMatchObject({ width: 896, height: 672 });
    // The square is the pair frame and stays the heaviest of the three on
    // purpose: two faces share its pixels, and it is the one frame where the
    // budget buys something.
    expect(sizeFor("1:1")).toEqual({ width: 896, height: 896 });
    for (const key of Object.keys(FORMATS)) {
      const f = sizeFor(key);
      expect(Math.max(f.width, f.height)).toBe(896);
      expect(f.width % 32).toBe(0);
      expect(f.height % 32).toBe(0);
      // Under half a megapixel Qwen smears; over one the phone screen ignores
      // what we paid for.
      expect((f.width * f.height) / 1e6).toBeGreaterThan(0.5);
      expect((f.width * f.height) / 1e6).toBeLessThan(1);
    }
  });

  it("falls back to 1:1 on an unknown format", () => {
    // Literal, not FORMATS["1:1"]: the table now carries a label as well as a
    // size, and `sizeFor` deliberately returns only the two numbers — it gets
    // spread into the graph.
    expect(sizeFor("16:9")).toEqual({ width: 896, height: 896 });
    expect(sizeFor(undefined)).toEqual({ width: 896, height: 896 });
  });

  it("sends the cloud a size its endpoints accept", () => {
    // The cloud endpoints take a short list, so the frame travels as its shape.
    expect(cloudSizeFor(sizeFor("1:1"))).toBe("1024x1024");
    expect(cloudSizeFor(sizeFor("3:4"))).toBe("1024x1536");
    expect(cloudSizeFor(sizeFor("4:3"))).toBe("1536x1024");
  });
});
