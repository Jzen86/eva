import { describe, it, expect } from "vitest";
import { alignHistory } from "../../src/core/llm/history.js";
import type { LLMMessage } from "../../src/core/llm/types.js";

const user = (text: string): LLMMessage => ({ role: "user", content: text });
const assistant = (text: string): LLMMessage => ({ role: "assistant", content: text });
const call = (id: string, ...ids: string[]): LLMMessage => ({
  role: "assistant",
  content: "",
  toolCalls: ids.map((x) => ({ id: x, name: "t", arguments: {} })),
});
const result = (id: string): LLMMessage => ({ role: "tool", content: "ok", toolCallId: id });

describe("alignHistory", () => {
  it("leaves a legal history alone", () => {
    const history = [
      user("привет"),
      call("a", "a"),
      result("a"),
      assistant("готово"),
      user("ещё"),
    ];
    // The same array, not an equal one: callers keep the history they also
    // store, and a copy here would silently swallow the next message.
    expect(alignHistory(history)).toBe(history);
  });

  it("drops a tool result whose call was cut away", () => {
    // What `slice(-N)` leaves behind when it lands inside a tool block: the
    // answer arrives, the question does not.
    const history = [result("a"), assistant("ага"), user("ещё")];
    expect(alignHistory(history)).toEqual([user("ещё")]);
  });

  it("opens the conversation on the user, not on the model", () => {
    // Same rule as an orphaned result, applied to a text reply: no provider
    // wants a conversation that starts with the assistant talking.
    const history = [assistant("ага"), user("ещё")];
    expect(alignHistory(history)).toEqual([user("ещё")]);
  });

  it("drops a leading assistant call along with it", () => {
    const history = [call("a", "a"), result("a"), user("ещё")];
    expect(alignHistory(history)).toEqual([user("ещё")]);
  });

  it("cuts a dangling call at the tail, with the answers it did get", () => {
    const history = [user("сделай"), call("a", "a", "b"), result("a"), call("c", "c")];
    // Half an answer is worse than none: `c` is never answered, and everything
    // from that call on would be judged against a request that cannot parse.
    expect(alignHistory(history)).toEqual([user("сделай")]);
  });

  it("keeps a call whose results are all present, mid-history", () => {
    const history = [
      user("на"),
      call("a", "a", "b"),
      result("a"),
      result("b"),
      assistant("сделала"),
      user("ещё"),
    ];
    expect(alignHistory(history)).toEqual(history);
  });

  it("cuts when a result belongs to a call that is not in the history", () => {
    const history = [user("на"), call("a", "a"), result("b"), assistant("ок")];
    expect(alignHistory(history)).toEqual([user("на")]);
  });

  it("cuts when more results arrive than calls asked for", () => {
    const history = [user("на"), call("a", "a"), result("a"), result("a")];
    expect(alignHistory(history)).toEqual([user("на")]);
  });

  it("cuts a tool result that follows a plain assistant message", () => {
    const history = [user("на"), assistant("подожди"), result("a")];
    expect(alignHistory(history)).toEqual([user("на"), assistant("подожди")]);
  });

  it("does not mutate the array it was given", () => {
    const history = [result("a"), user("ещё")];
    alignHistory(history);
    expect(history).toHaveLength(2);
  });

  it("returns nothing at all for a history that holds no user turn", () => {
    expect(alignHistory([call("a", "a"), result("a")])).toEqual([]);
  });
});
