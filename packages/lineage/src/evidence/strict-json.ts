/**
 * Finds the first object key that occurs twice within one JSON object, at any depth, in text that
 * `JSON.parse` has already accepted. `JSON.parse` keeps the last of two equal keys, so a duplicate makes
 * two parsers (or a parser and a human reading the raw bytes) disagree about which value the document
 * holds; evidence verification signs the parsed value, so it refuses a manifest.json with a duplicate
 * outright. Keys are compared after unescaping (`"a"` and `"a"` collide). Returns the offending
 * key, or `undefined` when every object's keys are unique.
 *
 * Precondition: `text` is valid JSON (a scan of anything else is undefined behavior, not an error).
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  // One frame per open container: an object's frame holds the keys seen so far, an array's is null.
  const stack: Array<Set<string> | null> = [];
  // True while the next string token inside the innermost object is a key (right after `{` or `,`).
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const keys = stack[stack.length - 1];
      if (keys != null && expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = stack[stack.length - 1] != null;
    }
    i += 1;
  }
  return undefined;
}
