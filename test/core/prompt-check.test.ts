import { describe, it, expect } from "vitest";
import { checkImagePrompt, checkSelfieContext } from "../../src/core/tools/prompt-check.js";

/**
 * What a picture prompt may not contain.
 *
 * The tool descriptions ask for one framing and the scene only, and the live install
 * went ahead and sent "extremely intimate close-up and full body view" anyway — both
 * halves sound like what was asked for — and came back as a diptych: one frame of her
 * face, one of the whole body. The check exists because a request in a prompt is
 * worth what the memory base's requests were worth: nothing enforceable.
 */
describe("picture prompt check", () => {
  it("refuses two scales in one prompt, by name", () => {
    // The live prompt, in its own words.
    const bad =
      "extremely intimate close-up and full body view of a nude woman lying on silk sheets, legs spread";
    const objection = checkImagePrompt(bad);
    expect(objection).toContain("два разных кадра");
    expect(objection).toContain("склейкой");
  });

  it("says nothing about a prompt with one scale", () => {
    expect(checkImagePrompt("lying on silk sheets, warm lamp light, three-quarter view")).toBeNull();
    expect(checkImagePrompt("full body shot standing by a window, morning light")).toBeNull();
    expect(checkImagePrompt("close-up of her face against a pillow, dim room")).toBeNull();
  });

  it("refuses a second description of her body", () => {
    // The canon already carries all of it, and a second description argues with the
    // first: the face drifts further from frame to frame.
    const objection = checkImagePrompt(
      "a woman with a perfect hourglass figure and 34D breasts, lying on the bed",
    );
    expect(objection).toContain("задана каноном");
  });

  it("lets a pose that only sounds like a body part through", () => {
    // "hands on hips" is a pose. A check that refuses it would be refusing the scene.
    expect(checkImagePrompt("standing with her hands on her hips, black lingerie")).toBeNull();
    expect(checkImagePrompt("flipping her long hair back, sitting on the bed")).toBeNull();
  });

  it("refuses two poses that cannot both be true", () => {
    const objection = checkImagePrompt("standing at the window, then lying on the bed");
    expect(objection).toContain("две позы сразу");
  });

  it("refuses two lights that cannot both be true", () => {
    const objection = checkImagePrompt("a dim bedroom at night with bright daylight through the window");
    expect(objection).toContain("два света сразу");
  });

  it("reports one problem, not a list of them", () => {
    // A prompt with two defects is rewritten whole anyway; a list of complaints
    // reads as a scolding rather than as an edit.
    const objection = checkImagePrompt(
      "close-up and full body view of her hourglass figure, standing and lying, dim daylight",
    );
    expect(objection).not.toBeNull();
    expect(objection!.split(".").filter((s) => s.trim()).length).toBeLessThanOrEqual(3);
  });

  it("takes a scene with an empty prompt without inventing a complaint", () => {
    expect(checkImagePrompt("")).toBeNull();
    expect(checkImagePrompt("   ")).toBeNull();
  });
});

describe("picture prompt check, for the selfie tool", () => {
  it("checks the scene she wrote, not the prompt the tool builds", () => {
    // buildPrompt opens with the canon and closes with "Full body visible in the
    // mirror" in mirror mode. Checking the finished prompt would refuse every selfie
    // ever asked for — the appearance words are the tool's own.
    expect(checkSelfieContext("reclining on rumpled sheets, one arm toward the phone", "mirror")).toBeNull();
  });

  it("catches the two scales when the mode and the scene disagree", () => {
    // Mirror mode already says "full body"; a close-up in the scene is the same
    // collision the diptych came from.
    const objection = checkSelfieContext("close-up of her face against the pillow", "mirror");
    expect(objection).toContain("полный рост");

    const other = checkSelfieContext("full body shot by the window", "direct");
    expect(other).toContain("крупный план");
  });

  it("still catches the body described a second time in a selfie scene", () => {
    const objection = checkSelfieContext("lying on the bed, her cheekbones catching the light", "direct");
    expect(objection).toContain("задана каноном");
  });
});
