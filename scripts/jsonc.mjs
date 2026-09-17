// A minimal JSON-with-comments reader, just enough for wrangler.jsonc.
//
// wrangler.jsonc carries long `//` explanatory comments (see the file itself) that plain
// JSON.parse chokes on, and there is no jsonc-parser-style package already in this project's
// dependency tree. Rather than add one for a single, simple config file, this strips `//` line
// comments and `/* */` block comments while respecting string literals (so a URL or a value
// that happens to contain `//` is never mistaken for a comment), then hands the result to
// JSON.parse. It does not support trailing commas — wrangler.jsonc has none, and if a future
// edit adds one, JSON.parse's own error is the right failure mode rather than silently guessing.
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === '\\') {
        // Preserve the escaped character verbatim so `\"`, `\\`, etc. never confuse the scan.
        out += next;
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }

  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}
