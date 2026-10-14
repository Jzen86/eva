import { describe, it, expect } from "vitest";
import { previewImage } from "../../src/core/image-preview.js";

/**
 * The preview exists because the owner noticed the delay as soon as she started
 * seeing her own pictures: a 1024-pixel PNG is ~1.5 MB, and base64 in the body of
 * every request is not what "look at this" should cost.
 *
 * The tests here keep the two edges honest without depending on ffmpeg being
 * installed: what is not an inline image, and what is already small enough.
 */
describe("previewImage", () => {
  it("returns null for something that is not an inline image", async () => {
    expect(await previewImage("https://example.com/a.png")).toBeNull();
    expect(await previewImage("data:image/png;base64,")).toBeNull();
    expect(await previewImage("вовсе не картинка")).toBeNull();
  });

  it("leaves an already small image alone", async () => {
    const small = Buffer.alloc(1000, 7).toString("base64");
    const result = await previewImage(`data:image/png;base64,${small}`);
    expect(result?.original).toBe(true);
    expect(result?.bytes).toBe(1000);
  });

  it("falls back to the original when it cannot be converted", async () => {
    // 300 KB of bytes that are not a picture: ffmpeg will refuse, and the honest
    // answer is the original — a slow look beats no look, and silence here would
    // put her back to guessing with no sign that anything broke.
    const junk = Buffer.alloc(300 * 1024, 3).toString("base64");
    const result = await previewImage(`data:image/png;base64,${junk}`);
    expect(result?.original).toBe(true);
    expect(result?.bytes).toBe(300 * 1024);
  });
});
