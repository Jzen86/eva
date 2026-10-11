import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelfieTool } from "../../../src/core/tools/selfie.js";
import type { ComfyClient } from "../../../src/core/comfy.js";

const PNG_URL = "data:image/png;base64,AAAA";
const imageReply = {
  ok: true,
  json: () => Promise.resolve({
    choices: [{ message: { images: [{ image_url: { url: PNG_URL } }] }, finish_reason: "stop" }],
  }),
};

describe("SelfieTool", () => {
  it("has correct name and parameters", () => {
    const tool = new SelfieTool({ openrouterApiKey: "k", referencePhotoUrl: "https://example.com/photo.jpg" });
    expect(tool.name).toBe("selfie");
    expect(tool.parameters).toHaveLength(3);
    expect(tool.parameters[0].name).toBe("context");
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.parameters[1].name).toBe("mode");
    expect(tool.parameters[1].required).toBe(false);
  });

  it("returns error when the OpenRouter key is missing", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "", referencePhotoUrl: "https://example.com/photo.jpg" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("OpenRouter");
  });

  it("sends the photo on disk when the config has no URL, which is the normal case", async () => {
    // `/setphoto` writes a file; the selfie tool must read that file, not a config
    // key nothing writes. The file is the reference; a URL is the override.
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "google/gemini-3.1-flash-lite-image",
      referencePath: file,
    });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    const result = await tool.execute({ context: "в кафе с кофе" });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("лицо не сохранено");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const parts = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe(
      `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`,
    );

    fs.unlinkSync(file);
    vi.unstubAllGlobals();
  });

  it("prefers a configured URL over the file on disk", async () => {
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/image",
      referencePhotoUrl: "https://example.com/remote.jpg",
      referencePath: file,
    });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "на пляже" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const parts = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toBe("https://example.com/remote.jpg");

    fs.unlinkSync(file);
    vi.unstubAllGlobals();
  });

  it("drops the photo and opens the prompt with the written canon", async () => {
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "google/gemini-3.1-flash-lite-image",
      referencePath: file,
      appearance: "A 25-year-old woman, warm olive skin",
    });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    const result = await tool.execute({ context: "в кафе с кофе" });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("лицо не сохранено");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // A string body, not the parts array: no photo goes with it.
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("A 25-year-old woman, warm olive skin");
    expect(body.messages[0].content).toContain("close-up selfie");

    fs.unlinkSync(file);
    vi.unstubAllGlobals();
  });

  it("calls an image-less answer a block, not a missing image", async () => {
    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/image",
      appearance: "A woman",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "no" }, finish_reason: "stop" }] }),
    }));

    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("отклонил сцену");
    expect(result.output).not.toContain("не вернул изображение");

    vi.unstubAllGlobals();
  });

  it("goes ahead on OpenRouter without a reference, and says the face is not preserved", async () => {
    // The free picture models take a prompt and cannot take a photo. A tool that
    // insists on a reference can therefore never call one.
    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/free-image",
      referencePhotoUrl: "",
    });
    // The provider names the other endpoint, and we take it.
    const chatFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("is an image generation model and cannot be used with the chat/completions endpoint"),
    });
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ b64_json: "AAAA", media_type: "image/png" }] }),
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) =>
      String(url).includes("/images/generations") ? okFetch() : chatFetch(),
    ));

    const result = await tool.execute({ context: "в кафе, широко улыбаясь" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("лицо не сохранено");
    expect(result.mediaUrl).toContain("data:image/png;base64,AAAA");

    vi.unstubAllGlobals();
  });

  it("tells ComfyUI the face comes from the reference, and only when there is one", async () => {
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const upload = vi.fn().mockResolvedValue("eva_ref.jpg");
    const generate = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/image",
      referencePath: file,
      appearance: "A woman with a balanced figure",
      comfy: { upload, generate } as unknown as ComfyClient,
    });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("data:image/png;base64,AAAA");

    const graph = generate.mock.calls[0][0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(graph["5"].inputs.prompt).toContain("reference image (image 1)");
    expect(graph["5"].inputs.prompt).toContain("A woman with a balanced figure");
    // The reference is edited in through EditPlus — it keeps the vision tokens
    // the plain encoder drops — not spliced as an images autogrow key.
    expect(graph["5"].class_type).toBe("TextEncodeQwenImageEditPlus");
    expect(graph["5"].inputs.image1).toEqual(["6", 0]);

    fs.unlinkSync(file);
  });

  it("puts the figure standard in the prompt and honors the requested format", async () => {
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const upload = vi.fn().mockResolvedValue("eva_ref.jpg");
    const generate = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/image",
      referencePath: file,
      body: "Woman with a balanced figure, a flat stomach",
      comfy: { upload, generate } as unknown as ComfyClient,
    });
    await tool.execute({ context: "в кафе", format: "4:3" });

    const graph = generate.mock.calls[0][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["5"].inputs.prompt).toContain("Woman with a balanced figure, a flat stomach");
    expect(graph["9"].inputs).toMatchObject({ width: 1152, height: 864 });

    fs.unlinkSync(file);
  });

  it("does not add the reference sentence when no photo is attached", async () => {
    const generate = vi.fn().mockResolvedValue("data:image/png;base64,AAAA");
    const tool = new SelfieTool({
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/image",
      referencePath: path.join(os.tmpdir(), "eva-no-such-reference.jpg"),
      appearance: "A woman with a balanced figure",
      comfy: { upload: vi.fn(), generate } as unknown as ComfyClient,
    });
    await tool.execute({ context: "в кафе" });

    const graph = generate.mock.calls[0][0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["5"].inputs.prompt).not.toContain("reference image (image 1)");
    expect(graph["6"]).toBeUndefined();
  });

  it("keeps a selfie quiet about faces when a reference is present", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageReply));

    const result = await tool.execute({ context: "моё лицо, то же самое" });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("лицо не сохранено");

    vi.unstubAllGlobals();
  });

  it("detects mirror mode from keywords", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в новом платье" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[0].text).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("detects direct mode from keywords", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в кафе с кофе" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[0].text).toContain("close-up selfie");

    vi.unstubAllGlobals();
  });

  it("returns mediaUrl on success", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageReply));

    const result = await tool.execute({ context: "на пляже" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe(PNG_URL);

    vi.unstubAllGlobals();
  });

  it("respects explicit mode parameter", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    const mockFetch = vi.fn().mockResolvedValue(imageReply);
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "просто так", mode: "mirror" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[0].text).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("handles API errors gracefully", async () => {
    const tool = new SelfieTool({ openrouterApiKey: "or-key", openrouterModel: "vendor/image", referencePhotoUrl: "https://example.com/photo.jpg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    const result = await tool.execute({ context: "тест" });
    expect(result.success).toBe(false);
    expect(result.output).toBeDefined();

    vi.unstubAllGlobals();
  });
});
