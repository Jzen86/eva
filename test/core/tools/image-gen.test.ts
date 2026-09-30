import { describe, it, expect, vi } from "vitest";
import { ImageGenTool } from "../../../src/core/tools/image-gen.js";

describe("ImageGenTool", () => {
  it("sends the written canon and no photo, so the provider has nothing to refuse", async () => {
    // The photo is the thing the image providers refuse to draw: a lingerie
    // reference failed even a sweater scene 7 of 8 times, and an intimate one
    // never passed. The canon says the same thing in words, and words are not
    // what the filter fires on.
    const tool = new ImageGenTool({ apiKey: "k", appearance: "A 25-year-old woman, warm olive skin" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{
          message: { images: [{ image_url: { url: "data:image/png;base64,AAAA" } }] },
          finish_reason: "stop",
        }],
      })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await tool.execute({ prompt: "cozy cafe, holding a coffee cup, warm daylight" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("data:image/png;base64,AAAA");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("A 25-year-old woman, warm olive skin");
    expect(body.messages[0].content).toContain("cozy cafe, holding a coffee cup, warm daylight");

    vi.unstubAllGlobals();
  });

  it("reads an image-less answer as a refusal, not as a broken endpoint", async () => {
    // The silent refusal: the model replies with words and calls it `stop`.
    // Reported as "the model did not return an image" it sent whoever debugged
    // it looking at the API, when the answer was the prompt.
    const tool = new ImageGenTool({ apiKey: "k", appearance: "A woman" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{ message: { content: "I can't help with that." }, finish_reason: "stop" }],
      })),
    }));

    const result = await tool.execute({ prompt: "a woman on a bed" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("отклонил");

    vi.unstubAllGlobals();
  });
});
