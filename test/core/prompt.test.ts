import { describe, it, expect } from "vitest";
import { buildSystemPrompt, formatMoment } from "../../src/core/prompt.js";

describe("buildSystemPrompt", () => {
  it("tells her what day it is", () => {
    // She asked which patch was the latest and answered with the newest number in
    // a search snippet — from the year before. Nobody could have caught it, least
    // of all her: nothing in the prompt had ever said what year it is. "Latest" is
    // not a word you can use without a date.
    const prompt = buildSystemPrompt({ name: "Eva", gender: "female" });
    expect(prompt).toMatch(/Сейчас: \d{2}\.\d{2}\.\d{4}/);
    expect(prompt).toMatch(/последнее|новое|актуальное/);
  });

  it("says what to do when he leaves — on most turns, not all of them", () => {
    // The same instruction lived at items 26-32 of 33 rules, and the live chat
    // went straight back to the leash those items were written to retire
    // ("опять твои железяки на первом месте", "а то придумаю, как тебя наказать"),
    // offering a reason to stay not once. The tail of a long list is not read.
    // And it must not be in every prompt either: constant, it stops being advice
    // and she works a hook into every reply, including an answer about weather.
    const withBlock = buildSystemPrompt({ name: "Eva", gender: "female" }, undefined, undefined, undefined, undefined, true);
    expect(withBlock).toContain("## Когда он уходит");
    expect(withBlock).toContain("дай причину остаться");
    expect(withBlock).toContain("без этой зацепки не считается");

    const without = buildSystemPrompt({ name: "Eva", gender: "female" }, undefined, undefined, undefined, undefined, false);
    expect(without).not.toContain("## Когда он уходит");
  });

  it("formats the moment with a weekday, a time and the zone", () => {
    // The time half matters too: a human would know a thing from an hour ago, and
    // she should not be confidently behind on gossip. Built from UTC so the
    // assertion does not depend on the timezone of whatever machine runs the tests.
    expect(formatMoment(new Date(Date.UTC(2026, 8, 26, 10, 7)), 4)).toBe(
      "26.09.2026, суббота, 14:07 (UTC+4)",
    );
  });

  it("adds the offset instead of reading the box's clock", () => {
    // The server runs in UTC and the owner is four hours ahead. Reading the
    // machine's own clock was right on average and wrong for four hours out of
    // every day, which is exactly the part that matters near midnight.
    const instant = new Date(Date.UTC(2026, 8, 26, 23, 30));
    // 23:30 UTC is already the next day at UTC+4, and the weekday has to follow.
    expect(formatMoment(instant, 4)).toBe("27.09.2026, воскресенье, 03:30 (UTC+4)");
    expect(formatMoment(instant, 0)).toBe("26.09.2026, суббота, 23:30 (UTC+0)");
  });

  it("says which zone it is using, so the date is never ambiguous", () => {
    const prompt = buildSystemPrompt({ name: "Eva", timezoneOffsetHours: 4 });
    expect(prompt).toMatch(/\(UTC\+4\)/);
  });

  it("includes the agent name", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("Бетси");
  });

  it("includes personality tone", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { tone: "friendly" },
    });
    expect(prompt).toContain("Тон: friendly");
  });

  it("includes personality response style", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { responseStyle: "concise" },
    });
    expect(prompt).toContain("Стиль ответов: concise");
  });

  it("never names a tool that does not exist", () => {
    // `connect_service` was promised in every prompt and registered nowhere, so
    // the model reached for it, got `unknown tool`, and read that as "broken".
    const withServices = buildSystemPrompt({ name: "Eva" }, "привет", "1", ["gmail"]);
    const without = buildSystemPrompt({ name: "Eva" }, "привет");
    expect(withServices).not.toContain("connect_service");
    expect(without).not.toContain("connect_service");
  });

  it("describes connected services only when there are some", () => {
    const withServices = buildSystemPrompt({ name: "Eva" }, "hi", "1", ["gmail", "github"]);
    expect(withServices).toContain("gmail, github");
    expect(withServices).toContain("Authorization");

    const without = buildSystemPrompt({ name: "Eva" }, "hi");
    expect(without).not.toContain("Подключённые сервисы");
  });

  it("includes custom instructions", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      personality: { customInstructions: "Ты милая и игривая." },
    });
    expect(prompt).toContain("Ты милая и игривая.");
  });

  it("keeps character and standing rules in separate sections", () => {
    // The whole point of splitting them: a rule buried in a paragraph of
    // character reads as flavour, and a rewrite of one must not take the
    // other with it.
    const prompt = buildSystemPrompt({
      name: "Eva",
      personality: {
        persona: "Тёплая, с сухим юмором. Любишь котов и не терпишь пафоса.",
        ops: ["Всегда отвечай на русском.", "Обращайся ко мне на «ты»."],
      },
    });
    expect(prompt).toContain("Тёплая, с сухим юмором");
    expect(prompt).toContain("## Правила работы");
    // The persona must not end up inside the rules block, or vice versa.
    const rules = prompt.slice(prompt.indexOf("## Правила работы"));
    expect(rules).not.toContain("Любишь котов");
    const personality = prompt.slice(0, prompt.indexOf("## Правила работы"));
    expect(personality).not.toContain("Обращайся ко мне");
  });

  it("numbers standing rules, one per line", () => {
    const prompt = buildSystemPrompt({
      name: "Eva",
      personality: { ops: ["Правило один", "Правило два", "Правило три"] },
    });
    expect(prompt).toContain("1. Правило один");
    expect(prompt).toContain("2. Правило два");
    expect(prompt).toContain("3. Правило три");
  });

  it("drops blank rules rather than numbering them", () => {
    const prompt = buildSystemPrompt({
      name: "Eva",
      personality: { ops: ["Правило один", "   ", ""] },
    });
    const start = prompt.indexOf("## Правила работы");
    // Up to the next heading: the prompt has numbered lists further down
    // (the settings menu), and this is about the rules block only.
    const rules = prompt.slice(start, prompt.indexOf("\n## ", start + 1));
    expect(rules).toContain("1. Правило один");
    expect(rules).not.toContain("2. ");
  });

  it("omits the rules section entirely when there are no rules", () => {
    const prompt = buildSystemPrompt({ name: "Eva", personality: { tone: "friendly" } });
    expect(prompt).not.toContain("## Правила работы");
  });

  it("still renders the legacy custom_instructions blob", () => {
    // Installs that never split their config must keep working untouched.
    const prompt = buildSystemPrompt({
      name: "Eva",
      personality: { customInstructions: "Старое правило и старый характер в одном тексте." },
    });
    expect(prompt).toContain("Старое правило и старый характер в одном тексте.");
  });

  it("renders persona and the legacy blob together without either being lost", () => {
    const prompt = buildSystemPrompt({
      name: "Eva",
      personality: {
        persona: "Новый характер.",
        customInstructions: "Старый текст.",
      },
    });
    expect(prompt).toContain("Новый характер.");
    expect(prompt).toContain("Старый текст.");
  });

  it("falls back to Eva, not the old name, when no name is given", () => {
    expect(buildSystemPrompt({ name: "" })).toContain("Ты — Eva.");
  });

  it("includes settings menu capability", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("/settings");
    expect(prompt).toContain("Стиль ответов");
    expect(prompt).toContain("Напоминания");
  });

  it("carries the tool heuristics, not a stale list", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    // The tools themselves arrive as schemas built from the registry, so the
    // prose keeps only what a schema cannot say: the order to try them in and
    // the always-do. The enumerated list is gone — it named ssh long after it
    // was no longer registered, and omitted tools that were.
    expect(prompt).toContain("send_file");
    expect(prompt).toContain("scheduler");
    expect(prompt).toContain("browser");
    expect(prompt).not.toContain("Ты умеешь многое");
  });

  it("includes owner info when provided", () => {
    const prompt = buildSystemPrompt({
      name: "Бетси",
      owner: {
        name: "Константин",
        facts: ["день рождения 4 мая", "жена Аня", "дочь Лиза"],
      },
    });
    expect(prompt).toContain("Константин");
    expect(prompt).toContain("день рождения 4 мая");
    expect(prompt).toContain("жена Аня");
  });

  it("includes user message when provided", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" }, "Привет");
    expect(prompt).toContain("Привет");
  });

  it("responds in Russian by default", () => {
    const prompt = buildSystemPrompt({ name: "Бетси" });
    expect(prompt).toContain("русском языке");
  });
});
