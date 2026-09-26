import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelfieTool } from "../../../src/core/tools/selfie.js";

describe("SelfieTool", () => {
  it("has correct name and parameters", () => {
    const tool = new SelfieTool({ falApiKey: "test", referencePhotoUrl: "https://example.com/photo.jpg" });
    expect(tool.name).toBe("selfie");
    expect(tool.parameters).toHaveLength(2);
    expect(tool.parameters[0].name).toBe("context");
    expect(tool.parameters[0].required).toBe(true);
    expect(tool.parameters[1].name).toBe("mode");
    expect(tool.parameters[1].required).toBe(false);
  });

  it("returns error when fal_api_key is missing", async () => {
    const tool = new SelfieTool({ falApiKey: "", referencePhotoUrl: "https://example.com/photo.jpg" });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("fal.ai");
  });

  it("still refuses without a reference on fal, which cannot work without one", async () => {
    // Not a blanket rule. The fal backend is a "same face, new pose" endpoint:
    // with no face there is nothing to mirror, and pretending otherwise would
    // send an empty image_url and return a provider error instead of a sentence
    // the owner can act on.
    // The path is named explicitly so the answer does not depend on whether the
    // machine running the tests happens to have a photo beside its config.
    const tool = new SelfieTool({
      falApiKey: "key-123",
      referencePhotoUrl: "",
      referencePath: path.join(os.tmpdir(), "eva-no-such-reference.jpg"),
    });
    const result = await tool.execute({ context: "в кафе" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("фото");
  });

  it("sends the photo on disk when the config has no URL, which is the normal case", async () => {
    // The bug this guards: `/setphoto` writes a file, `doctor` reports that file,
    // `image_gen` reads that file — and the selfie tool read a config key that
    // nothing in the project has ever written. So the install had a reference
    // photo, a report saying so, and a selfie tool drawing a stranger. The file
    // is the reference; a URL is the override.
    const file = path.join(os.tmpdir(), `eva-ref-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    const tool = new SelfieTool({
      provider: "openrouter",
      openrouterApiKey: "or-key",
      openrouterModel: "google/gemini-3.1-flash-lite-image",
      referencePath: file,
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "![x](data:image/png;base64,BBBB)" } }],
      }),
    });
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
      falApiKey: "key-123",
      referencePhotoUrl: "https://example.com/remote.jpg",
      referencePath: file,
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ images: [{ url: "https://fal.media/result.jpg" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "на пляже" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.image_url).toBe("https://example.com/remote.jpg");

    fs.unlinkSync(file);
    vi.unstubAllGlobals();
  });

  it("goes ahead on OpenRouter without a reference, and says the face is not preserved", async () => {
    // The free picture models take a prompt and cannot take a photo. A tool that
    // insists on a reference can therefore never call one, and the install keeps
    // paying $0.0672 a picture while a free model sits in the config unused.
    const tool = new SelfieTool({
      provider: "openrouter",
      openrouterApiKey: "or-key",
      openrouterModel: "vendor/free-image",
      referencePhotoUrl: "",
    });
    // The provider names the other endpoint, and we take it.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () =>
        Promise.resolve("is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint"),
    });
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ b64_json: "AAAA", media_type: "image/png" }] }),
    });
    mockFetch.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve("is an image generation model and cannot be used with the chat/completions endpoint"),
    }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) =>
      String(url).includes("/images/generations") ? okFetch() : mockFetch(),
    ));

    const result = await tool.execute({ context: "в кафе, широко улыбаясь" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("лицо не сохранено");
    expect(result.mediaUrl).toContain("data:image/png;base64,AAAA");
  });

  it("keeps a selfie quiet about faces when a reference is present", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ images: [{ url: "https://fal.media/result.jpg" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await tool.execute({ context: "моё лицо, то же самое" });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("лицо не сохранено");
  });

  it("detects mirror mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в новом платье" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("detects direct mode from keywords", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "в кафе с кофе" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("close-up selfie");

    vi.unstubAllGlobals();
  });

  it("returns mediaUrl on success", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    }));

    const result = await tool.execute({ context: "на пляже" });
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("https://fal.media/result.jpg");

    vi.unstubAllGlobals();
  });

  it("respects explicit mode parameter", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: "https://fal.media/result.jpg" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await tool.execute({ context: "просто так", mode: "mirror" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.prompt).toContain("mirror selfie");

    vi.unstubAllGlobals();
  });

  it("handles API errors gracefully", async () => {
    const tool = new SelfieTool({ falApiKey: "key-123", referencePhotoUrl: "https://example.com/photo.jpg" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    const result = await tool.execute({ context: "тест" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    vi.unstubAllGlobals();
  });
});
