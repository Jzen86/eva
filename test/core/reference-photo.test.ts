import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  referencePhotoPath,
  hasReferencePhoto,
  describeReferencePhoto,
  saveReferencePhoto,
  ReferencePhotoError,
} from "../../src/core/reference-photo.js";

/**
 * The photo is the one piece of a person that arrives as a file, so it is the
 * one piece that can be a typo, a directory, a private key, or a megabyte of
 * something else. Every test below is one of those, caught before it became her
 * face.
 */

let dir: string;
let configPath: string;

const PIXEL = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

beforeEach(() => {
  dir = path.join(os.tmpdir(), `eva-photo-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  configPath = path.join(dir, "config.yaml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, data: Buffer | string = PIXEL): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
};

describe("referencePhotoPath", () => {
  it("puts the photo beside the config, not in a directory of its own", () => {
    // EVA_CONFIG_PATH can move the whole install. A photo that init wrote to
    // ~/.eva while the running bot looked in /etc/eva exists and is never seen.
    expect(referencePhotoPath(configPath)).toBe(path.join(dir, "reference.jpg"));
  });

  it("follows a config path in a directory that does not exist yet", () => {
    const nested = path.join(dir, "a", "b", "config.yaml");
    expect(referencePhotoPath(nested)).toBe(path.join(dir, "a", "b", "reference.jpg"));
  });
});

describe("hasReferencePhoto", () => {
  it("is false for a missing file, and false rather than throwing", () => {
    expect(hasReferencePhoto(configPath)).toBe(false);
  });

  it("is false for a zero-byte file, which is a failed download not a photo", () => {
    write("reference.jpg", Buffer.alloc(0));
    expect(hasReferencePhoto(configPath)).toBe(false);
  });

  it("is true once there are bytes", () => {
    saveReferencePhoto(write("portrait.jpg"), configPath);
    expect(hasReferencePhoto(configPath)).toBe(true);
  });
});

describe("describeReferencePhoto", () => {
  it("says «нет» instead of throwing when there is no photo", () => {
    expect(describeReferencePhoto(configPath)).toBe("нет");
  });

  it("shows the path and size, never the photo", () => {
    saveReferencePhoto(write("portrait.jpg"), configPath);
    const text = describeReferencePhoto(configPath);
    expect(text).toContain("reference.jpg");
    expect(text).toMatch(/\d+ КБ/);
  });
});

describe("saveReferencePhoto", () => {
  it("copies a real image into place and reports where it went", () => {
    const dest = saveReferencePhoto(write("portrait.png"), configPath);
    expect(dest).toBe(path.join(dir, "reference.jpg"));
    expect(fs.readFileSync(dest).equals(PIXEL)).toBe(true);
  });

  it("creates the directory when the install has none yet", () => {
    const nested = path.join(dir, "fresh", "config.yaml");
    const dest = saveReferencePhoto(write("p.jpg"), nested);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("replaces an old photo rather than keeping both", () => {
    saveReferencePhoto(write("old.jpg", Buffer.from("first")), configPath);
    saveReferencePhoto(write("new.jpg", Buffer.from("second")), configPath);
    expect(fs.readFileSync(path.join(dir, "reference.jpg")).toString()).toBe("second");
  });

  it("refuses a path that does not exist", () => {
    expect(() => saveReferencePhoto(path.join(dir, "ghost.jpg"), configPath)).toThrow(
      ReferencePhotoError,
    );
  });

  it("refuses a directory, which a drag from a file manager produces", () => {
    const sub = path.join(dir, "photos");
    fs.mkdirSync(sub);
    expect(() => saveReferencePhoto(sub, configPath)).toThrow(/не файл/i);
  });

  it("refuses an empty file", () => {
    expect(() => saveReferencePhoto(write("empty.jpg", Buffer.alloc(0)), configPath)).toThrow(
      /пустой/i,
    );
  });

  it("refuses something that is not an image, whatever the owner calls it", () => {
    // The extension is the only signal available, and a key named .pem or a
    // config named .yaml must never become her face.
    for (const name of ["id_rsa", "config.yaml", "notes.txt", "archive"]) {
      expect(() => saveReferencePhoto(write(name, "not a photo"), configPath)).toThrow(
        /не картинка/i,
      );
    }
    expect(fs.existsSync(path.join(dir, "reference.jpg"))).toBe(false);
  });

  it("accepts the formats a phone actually produces", () => {
    for (const ext of ["jpg", "jpeg", "png", "webp", "heic"]) {
      expect(saveReferencePhoto(write(`p.${ext}`), configPath)).toBe(
        path.join(dir, "reference.jpg"),
      );
    }
  });

  it("accepts an uppercase extension, because phones do that too", () => {
    expect(() => saveReferencePhoto(write("P.JPEG"), configPath)).not.toThrow();
  });
});
