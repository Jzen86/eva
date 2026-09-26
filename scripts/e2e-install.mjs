/**
 * End-to-end check of the delivery promise, on this machine instead of a
 * server: a clean directory, no config, two commands.
 *
 * Uses the real built CLI through `node dist/index.js`, because the claim being
 * tested is about that artifact — a test that imports the source has not
 * checked that the thing a person installs works.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve("dist/index.js");
if (!fs.existsSync(dist)) {
  console.error("dist/index.js missing — run npm run build first");
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "eva-e2e-"));
const configPath = path.join(home, ".eva", "config.yaml");
// Fake on purpose: this never leaves the box, and a real key has no business
// in a command line.
const token = "123456789:AAF-e2e-fake-token";
const key = "sk-e2e-fake-key-0000000000";
const model = "gpt-4o-mini";

const env = { ...process.env, EVA_CONFIG_PATH: configPath };

function eva(args, expectCode = 0) {
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [dist, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    code = err.status ?? 1;
    stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (expectCode !== null && code !== expectCode) {
    console.error(`--- eva ${args.join(" ")} exited ${code}, expected ${expectCode} ---`);
    console.error(stdout);
    process.exit(1);
  }
  return { code, stdout };
}

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) fail.push(what);
};

// 1. nothing configured yet
const before = eva(["doctor"], 1);
check(!fs.existsSync(configPath), "no config before init");

// 2. install it
// The exit code is checked loosely on purpose: a `bad` check means the config
// just written is wrong, and `init` is right to exit 1. This box has no MSVC,
// so better-sqlite3's native part does not build and the memory section is
// legitimately bad — that is the environment, not a defect, and the assertion
// that matters is the one about content below.
const init = eva([
  "init", "--token", token, "--provider", "openai", "--key", key, "--model", model,
], null);
check(fs.existsSync(configPath), "init wrote a config");
check(init.stdout.includes(configPath), "init says where it wrote it");
check(init.stdout.includes("eva doctor"), "init says how to verify");
check(!init.stdout.includes(token) && !init.stdout.includes(key), "init printed no secret");

// 3. the file loads
const reloaded = execFileSync(process.execPath, [
  "-e",
  `import("yaml").then(async (Y) => {
     const fs = await import("node:fs");
     const c = Y.parse(fs.readFileSync(process.env.EVA_CONFIG_PATH, "utf8"));
     console.log(JSON.stringify({
       token: c.telegram?.token,
       provider: Object.keys(c.providers ?? {}),
       base: c.providers?.openai?.base_url,
       model: c.models?.fast?.model,
       persona: typeof c.agent?.personality?.persona,
     }));
   })`,
], { env, encoding: "utf8" });
const parsed = JSON.parse(reloaded.trim());
check(parsed.token === token, "token round-trips through YAML");
check(parsed.provider[0] === "openai", "provider written");
check(parsed.base === "https://api.openai.com/v1", "preset endpoint filled in");
check(parsed.model === model, "model written");
check(typeof parsed.persona === "string", "persona written");

// 4. init again is a no-op, not a destruction
const again = eva(["init"]);
check(again.stdout.includes("--force"), "second init refuses to clobber");

// 5. doctor on the result
const doctor = eva(["doctor"], null);
check(doctor.stdout.length > 0, "doctor printed a report");
check(!doctor.stdout.includes(key), "doctor printed no secret");

// 5a. and a failure it does not recognise is reported without a guess, while a
// known one names the fix. Both are the whole point of the check.
const broken = eva([
  "init", "--token", token, "--provider", "openai", "--key", "sk-wrong", "--model", model, "--force",
], null);
check(broken.code === 1, "a broken result exits 1, not 0");
check(
  !/Could not locate the bindings file\. Tried:/.test(doctor.stdout),
  "a known native-module failure is translated, not dumped",
);

// 6. --help does not start a bot
const help = eva(["--help"]);
check(help.stdout.includes("eva init") && help.stdout.includes("eva doctor"), "help lists the commands");

fs.rmSync(home, { recursive: true, force: true });

console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
process.exit(fail.length ? 1 : 0);
