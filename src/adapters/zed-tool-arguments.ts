import { createHash } from "node:crypto";

/** Object order is immaterial; array order and string contents remain significant. */
export function zedArgumentFingerprint(text: string, custom: boolean): string {
  const hash = createHash("sha256");
  if (custom) return hash.update("custom:").update(text).digest("hex");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return hash.update("raw:").update(text).digest("hex"); }
  hash.update("json:");
  const stack: unknown[] = [value];
  while (stack.length) {
    const next = stack.pop();
    if (next !== null && typeof next === "object") {
      if (Array.isArray(next)) {
        hash.update(`array:${next.length}:`);
        for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
      } else {
        const record = next as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        hash.update(`object:${keys.length}:`);
        for (let i = keys.length - 1; i >= 0; i--) stack.push(record[keys[i]!], keys[i]!);
      }
    } else {
      // JSON.parse can produce +/-Infinity from a valid exponent such as 1e400.
      // JSON.stringify would collapse both numbers and null to the same token.
      const scalar = typeof next === "number" ? Object.is(next, -0) ? "-0" : String(next) : JSON.stringify(next);
      hash.update(`scalar:${typeof next}:${scalar.length}:${scalar}`);
    }
  }
  return hash.digest("hex");
}

function equalJson(left: string, right: string): boolean {
  try { return Bun.deepEquals(JSON.parse(left), JSON.parse(right)); } catch { return false; }
}

function unfinishedJsonValue(text: string): boolean {
  const value = text.trimStart();
  if (!value) return true;
  if (value[0] !== "{" && value[0] !== "[" && value[0] !== '"') {
    return ["true", "false", "null"].some(literal => literal.startsWith(value))
      || /^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?)?$/.test(value);
  }
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') {
      quoted = !quoted;
      if (!quoted && value[0] === '"') return false;
    } else if (!quoted) {
      if (char === "{" || char === "[") depth++;
      if (char === "}" || char === "]") {
        if (--depth <= 0) return false;
      }
    }
  }
  return true;
}

/** A number token or unfinished value may still extend; closure validates the final prefix. */
export function consistentZedArgumentDelta(prefix: string, full: string, custom: boolean): boolean {
  if (custom) return full.startsWith(prefix);
  try {
    const value: unknown = JSON.parse(prefix);
    return typeof value === "number" || Bun.deepEquals(value, JSON.parse(full));
  } catch { return unfinishedJsonValue(prefix); }
}

/** Locate a prefix modulo insignificant JSON whitespace, never whitespace inside strings. */
function prefixEnd(prefix: string, full: string): number | undefined {
  let p = 0;
  let f = 0;
  let quoted = false;
  let escaped = false;
  while (p < prefix.length) {
    if (!quoted) {
      while (p < prefix.length && /[\x20\t\r\n]/.test(prefix[p]!)) p++;
      while (f < full.length && /[\x20\t\r\n]/.test(full[f]!)) f++;
      if (p === prefix.length) break;
    }
    const char = prefix[p++];
    if (char !== full[f++]) return;
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return f;
}

/** Keep every delivered byte and append only a suffix that still represents the full value. */
export function reconcileZedArguments(prefix: string, full: string, custom: boolean): string | undefined {
  if (full.startsWith(prefix)) return full;
  if (custom) return;
  if (equalJson(prefix, full)) return prefix;
  const end = prefixEnd(prefix, full);
  if (end === undefined) return;
  const rebuilt = prefix + full.slice(end);
  return equalJson(rebuilt, full) ? rebuilt : undefined;
}
