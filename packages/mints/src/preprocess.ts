export function escapeWhistespace(input: string) {
  return input
    .replace(/[ ]{1,}/gmu, (text) => `@W${text.length}}`)
    .replace(/\n{1,}/gmu, (text) => `@N${text.length}}`);
}

export function restoreEscaped(input: string, literals: Map<string, string>) {
  return input.replace(/@(W|L|N)(\d+)\}/g, (full, type, $2) => {
    if (type === "L") {
      return literals.get(full) as string;
    }
    if (type === "W") {
      return " ".repeat(Number($2));
    }
    if (type === "N") {
      return "\n".repeat(Number($2));
    }
    throw new Error(`Unknown type ${type}`);
  });
}

export function escapeLiteral(input: string) {
  const literals = new Map();
  let cnt = 1;
  const escaped = input.replace(
    /"[^"]*"|'[^']*'|`[^`]*`|\/!\*[^\/]*!\*\//gmu,
    (text) => {
      const key = `@L${cnt++}}`;
      literals.set(key, text);
      return key;
    }
  );
  return { escaped, literals };
}

export function preprocess(input: string) {
  const { escaped, literals } = escapeLiteral(input);
  const modified = escaped
    // delete inline comments
    .replace(/\/\*([.\n]*?)\*\//gmu, "")
    // delete line comments
    .replace(/(.*)(\/\/.*)/gu, "$1");
  const tokenized = escapeWhistespace(modified);
  // TODO: return tokenized and handle it direct
  return restoreEscaped(tokenized, literals);
}

export function postprocess(input: string, literals: Map<string, string>) {
  return restoreEscaped(input, literals);
}

import { is, run, test } from "@mizchi/test";
const isMain = require.main === module;
if (process.env.NODE_ENV === "test") {
  const now = Date.now();
  test("strip inline comment", () => {
    is(preprocess("/**/"), "");
    is(preprocess("/**/a/**/"), "a");
    is(preprocess("/*\n*/ax/**/"), "ax");
  });

  test("line comment", () => {
    is(preprocess("a"), "a");
    is(preprocess("//a"), "");
    is(preprocess(" //a"), " ");
    is(preprocess("//a\n//b"), "\n");
    is(preprocess("a//a\n//b"), "a\n");
    is(preprocess("a//a\n//b"), "a\n");
    is(preprocess("a\n//xxx\n"), "a\n\n");
  });

  test("escape literal", () => {
    is(escapeLiteral(`"x"`), { escaped: `@L1}` });
    is(escapeLiteral(`"x" "y"`), { escaped: `@L1} @L2}` });
    is(escapeLiteral(`"x" "y" 'zzz'`), { escaped: `@L1} @L2} @L3}` });
    const e = escapeLiteral(`"x" "y" 'zzz'`);
    is(restoreEscaped(e.escaped, e.literals), `"x" "y" 'zzz'`);
  });

  test("tokenize whitespace", () => {
    is(escapeWhistespace(` a`), `@W1}a`);
    is(escapeWhistespace(`  a`), `@W2}a`);
    is(escapeWhistespace(`  a `), `@W2}a@W1}`);
    is(restoreEscaped(escapeWhistespace(`  a  `), new Map()), `  a  `);
  });

  run({ stopOnFail: true, stub: true, isMain }).then(() => {
    console.log("[test:time]", Date.now() - now);
  });
}