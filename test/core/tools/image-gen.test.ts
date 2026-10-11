import { describe, it, expect, vi } from "vitest";
import { ImageGenTool } from "../../../src/core/tools/image-gen.js";
import type { ComfyClient } from "../../../src/core/comfy.js";

describe("ImageGenTool", () => {
  it("sends the prompt exactly as written, with nothing prepended", async () => {
    // No canon, no reference: this tool draws a picture, not her. The prompt is
    // the whole request.
    const tool = new ImageGenTool({ apiKey: "k" });
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

    const prompt = "a red vintage car on a rainy street, cinematic";
    const result = await tool.execute({ prompt });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("data:image/png;base64,AAAA");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe(prompt);
    expect(mockFetch.mock.calls[0][1].body).not.toContain("reference image");

    vi.unstubAllGlobals();
  });

  it("lets her write a person's whole appearance, unlike the selfie", async () => {
    // This tool invents the person, so the words the selfie refuses because the
    // canon already says them (jawline, flat stomach, …) must pass here.
    const generate = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const tool = new ImageGenTool({ apiKey: "k", comfy: { generate } as unknown as ComfyClient });
    const result = await tool.execute({ prompt: "a woman with a sharp jawline and a flat stomach" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("data:image/png;base64,AAAA");
    expect(generate).toHaveBeenCalled();
  });

  it("still refuses a prompt with two framings at once", async () => {
    const tool = new ImageGenTool({ apiKey: "k" });
    const result = await tool.execute({ prompt: "a close-up full body portrait" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("два разных кадра");
  });

  it("reads an image-less answer as a refusal, not as a broken endpoint", async () => {
    // The silent refusal: the model replies with words and calls it `stop`.
    // Reported as "the model did not return an image" it sent whoever debugged
    // it looking at the API, when the answer was the prompt.
    const tool = new ImageGenTool({ apiKey: "k" });
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
