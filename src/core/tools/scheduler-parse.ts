/**
 * Parse a relative time string ("+5m", "+2h30m", "+1d") or ISO datetime
 * into an absolute Unix timestamp in milliseconds.
 *
 * `offsetHours` is the owner's clock against UTC, and it is the clock a bare ISO
 * string is read in. The server runs on UTC while he is four hours ahead, so
 * "2026-10-15T20:00" — which is how *he* writes eight in the evening — was parsed
 * as 20:00 UTC and fired at midnight his time, and the answer naming the moment
 * was wrong in the same direction. A string that already names its zone (`Z`,
 * `+03:00`) is his own words and is left alone. Relative forms are offsets from
 * now and carry no zone at all.
 */
export function parseAtTime(input: string, now: number, offsetHours: number): number {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) {
    return now + parseRelativeDuration(trimmed.slice(1));
  }

  const date = new Date(withOwnerOffset(trimmed, offsetHours));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid time: "${input}". Use "+5m", "+2h", or ISO datetime.`);
  }
  return date.getTime();
}

/**
 * "2026-10-15T20:00" → "2026-10-15T20:00+04:00"; a string that already names its
 * zone comes back unchanged.
 *
 * A bare date ("2026-10-15") is midnight on his clock for the same reason: ISO
 * reads it as UTC, and a reminder set for "the fifteenth" would land on the
 * fourteenth at eight in the evening.
 */
function withOwnerOffset(input: string, offsetHours: number): string {
  if (/[zZ]$/.test(input) || /[+-]\d{2}:?\d{2}$/.test(input)) return input;

  const sign = offsetHours < 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const hours = String(Math.floor(abs)).padStart(2, "0");
  const minutes = String(Math.round((abs - Math.floor(abs)) * 60)).padStart(2, "0");
  const zone = `${sign}${hours}:${minutes}`;
  return `${/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00` : input}${zone}`;
}

/**
 * Parse a duration string ("30s", "5m", "2h", "1d") into milliseconds.
 */
export function parseEveryDuration(input: string): number {
  return parseRelativeDuration(input);
}

function parseRelativeDuration(input: string): number {
  const regex = /(\d+)\s*(d|h|m|s)/g;
  let totalMs = 0;
  let matched = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case "d": totalMs += value * 86_400_000; break;
      case "h": totalMs += value * 3_600_000; break;
      case "m": totalMs += value * 60_000; break;
      case "s": totalMs += value * 1_000; break;
    }
  }

  if (!matched || totalMs <= 0) {
    throw new Error(`Invalid duration: "${input}". Use "5m", "2h", "1d", etc.`);
  }

  return totalMs;
}
