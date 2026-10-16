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

  it("asks the images endpoint for the requested frame", async () => {
    // The cloud fallback cannot reach EmptyLatentImage, so the size has to travel
    // as a request field — the owner's Eva noticed it did not, and she was right.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch = vi.fn(async (url: unknown, init: { body: string }) => {
      const u = String(url);
      calls.push({ url: u, body: JSON.parse(init.body) as Record<string, unknown> });
      if (u.endsWith("/chat/completions")) {
        return {
          ok: false,
          status: 404,
          text: () => Promise.resolve("No endpoints found that support the requested output modalities"),
        };
      }
      return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [{ b64_json: "AAAA", media_type: "image/png" }] })),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = new ImageGenTool({ apiKey: "k" });
    const result = await tool.execute({ prompt: "a tower", format: "3:4" });
    expect(result.success).toBe(true);
    const imagesCall = calls.find((c) => c.url.endsWith("/images/generations"));
    expect(imagesCall?.body.size).toBe("1024x1536");

    vi.unstubAllGlobals();
  });

  it("says the frame is in front of her when it is bytes, and stays quiet when it is a link", async () => {
    // Same reason as in the selfie: the attach lives in the engine, and a tool
    // that answers only "отправлено в чат" reads as "you never see it" to anyone
    // reading this file — which is how she concluded she worked blind.
    const generate = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const local = new ImageGenTool({ apiKey: "k", comfy: { generate } as unknown as ComfyClient });
    const shown = await local.execute({ prompt: "a red vintage car" });
    expect(shown.output).toContain("приложен к этому же ходу");

    const cloud = new ImageGenTool({ apiKey: "k" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{
          message: { images: [{ image_url: { url: "https://cdn.example/car.png" } }] },
          finish_reason: "stop",
        }],
      })),
    }));
    const linked = await cloud.execute({ prompt: "a red vintage car" });
    expect(linked.success).toBe(true);
    expect(linked.mediaUrl).toBe("https://cdn.example/car.png");
    expect(linked.output).not.toContain("приложен к этому же ходу");
    expect(cloud.description).toContain("приходит к тебе в этом же ходу");

    vi.unstubAllGlobals();
  });
});
