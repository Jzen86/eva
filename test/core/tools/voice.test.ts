import { describe, it, expect } from "vitest";
import { VoiceTool } from "../../../src/core/tools/voice.js";

/**
 * What the tool promises her about its own behaviour.
 *
 * On 18.10 the owner wrote one message — "Осталось проверить нам селфи, голос,
 * картинку" — and got back a plan and a stage direction ("(Генерирую свежее
 * селфи под текущий момент)") with **no tool call at all**: no selfie, no voice,
 * no picture that day. The turn ran on `fast` with 69 messages of history and a
 * prompt of 38.7k tokens, and the small model narrated the work instead of doing
 * it — so the one place that says "a call is the beginning of the thing" is the
 * description she reads, next to the same promise about the frame.
 *
 * Asked directly ("сделай селфи", "скажи голосом") she called all three tools and
 * every frame arrived (checked in the journal the same morning), which is why this
 * is a wording rule and not a missing tool.
 */
describe("voice tool description", () => {
  it("says a voice that was only announced does not exist", () => {
    const tool = new VoiceTool({ voiceConfig: {} });
    expect(tool.description).toContain("без вызова");
    expect(tool.description).toContain("уходит в этом же ходу");
  });
});
