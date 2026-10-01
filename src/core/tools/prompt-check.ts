/**
 * What a picture prompt must not contain, checked before the request leaves.
 *
 * The tool descriptions already ask for one framing and for the scene only. A
 * request in a prompt is what the previous version of the memory base was worth:
 * the model reads it, agrees with it, and then writes "extremely intimate close-up
 * and full body view" anyway, because both halves sound like what was asked for.
 * That exact prompt reached the provider on the live install and came back as a
 * diptych — one frame of her face, one of the whole body — and a wasted picture.
 *
 * So the three defects observed live are checked in code, on the prompt, before any
 * money is spent:
 *
 *  1. Two scales at once. "close-up" and "full body" are two different pictures,
 *     and the model solves the contradiction by drawing both.
 *  2. Her appearance, described a second time. It travels in `selfies.appearance`;
 *     a second description in the scene does not reinforce it, it argues with it,
 *     and the face drifts further between frames.
 *  3. A scene that contradicts itself — standing and lying, night and daylight.
 *     The model splits the difference and the picture reads as an error.
 *
 * Rejecting is cheap and correcting is cheap: no request is made, the model is told
 * what is wrong in the same turn, and it rewrites the prompt before the owner sees
 * anything. The tool keeps one guard against a loop — see `rejectedOnce` in the
 * callers — because a check that can never be satisfied would trap her.
 *
 * The word lists are deliberately narrow. "hands on hips" is a pose and must pass;
 * hair style, pose, clothes and light are hers to choose and must pass. A false
 * refusal costs a turn; a list that grows into taste costs the thing itself.
 */

/** Two framings in one prompt. */
const CLOSE_UP = /\b(close[- ]?up|macro|extreme close)\b/i;
const FULL_BODY = /\b(full[- ]?body|full[- ]?length|whole body|head to toe)\b/i;

/**
 * Words that only ever describe her body as an object, never a pose or a scene.
 *
 * Kept to what is written in the canon and what a scene would never legitimately
 * need: nobody poses "on her cheekbones".
 */
const APPEARANCE_WORDS = [
  "hourglass",
  "34d",
  "perky",
  "almond-shaped",
  "almond shaped",
  "cheekbones",
  "jawline",
  "olive skin",
  "plump lips",
  "natural skin texture",
  "narrow waist",
  "flat stomach",
  "long legs",
];

/** Poses that cannot both be true of one body at one moment. */
const STANDING = /\b(standing|stands|stand up|upright)\b/i;
const LYING = /\b(lying|lying down|reclining|reclines|lounging|sprawled)\b/i;

/** Light that cannot both be true of one room at one moment. */
const NIGHT_LIGHT = /\b(dimly lit|dim|dark|darkness|night|moonlit|candlelit|midnight)\b/i;
const DAY_LIGHT = /\b(daylight|broad daylight|bright|sunny|sunlight|sunlit|morning light)\b/i;

function find(text: string, words: string[]): string | null {
  const lower = text.toLowerCase();
  for (const w of words) {
    if (lower.includes(w)) return w;
  }
  return null;
}

/**
 * The objection to this prompt, or null when it is fit to send.
 *
 * Only the first defect is reported. A prompt with two of them is rewritten whole
 * anyway, and a list of complaints reads as a scolding rather than as an edit.
 */
export function checkImagePrompt(prompt: string): string | null {
  if (!prompt.trim()) return null;

  if (CLOSE_UP.test(prompt) && FULL_BODY.test(prompt)) {
    return (
      "В промпте два разных кадра сразу: и крупный план, и полный рост. Модель отвечает на это " +
      "склейкой из двух картинок. Оставь один масштаб — и вызови снова."
    );
  }

  const appearance = find(prompt, APPEARANCE_WORDS);
  if (appearance) {
    return (
      `Ты описываешь её внешность («${appearance}») — она уже целиком задана каноном, и второе ` +
      "описание спорит с первым: лицо дрейфует сильнее, кадр плывёт. Опиши только сцену " +
      "(место, поза, что на ней, причёска, свет) — и вызови снова."
    );
  }

  if (STANDING.test(prompt) && LYING.test(prompt)) {
    return (
      "В промпте две позы сразу — и стоя, и лёжа. Одновременно так не бывает, и модель будет " +
      "метаться. Оставь одну позу — и вызови снова."
    );
  }

  if (NIGHT_LIGHT.test(prompt) && DAY_LIGHT.test(prompt)) {
    return (
      "В промпте два света сразу — и сумрак, и день. В одной комнате так не бывает. Оставь один " +
      "свет — и вызови снова."
    );
  }

  return null;
}

/**
 * The same check for the selfie tool, which cannot be handed the built prompt.
 *
 * `buildPrompt` opens with the canon and closes with the framing its own mode
 * demands — "Full body visible in the mirror" or "A close-up selfie" — so running
 * the checks above on the finished prompt would refuse every selfie ever asked for.
 * The scene is the part she wrote, and that is what is checked; the framing is then
 * compared with the mode, because that is where the two scales collide: ask for a
 * close-up in mirror mode and the finished prompt contains both.
 */
export function checkSelfieContext(
  context: string,
  mode: "mirror" | "direct",
): string | null {
  const base = checkImagePrompt(context);
  if (base) return base;

  if (mode === "mirror" && CLOSE_UP.test(context)) {
    return (
      "Режим у селфи — зеркало, то есть кадр в полный рост, а в сцене просишь крупный план. " +
      "Это два разных кадра, и модель ответит склейкой. Оставь один: либо пиши сцену без крупного " +
      "плана, либо бери режим direct — и вызови снова."
    );
  }

  if (mode === "direct" && FULL_BODY.test(context)) {
    return (
      "Режим у селфи — direct, это крупный план, а в сцене просишь полный рост. Модель ответит " +
      "склейкой из двух кадров. Оставь один: либо убери полный рост из сцены, либо бери режим " +
      "mirror — и вызови снова."
    );
  }

  return null;
}
