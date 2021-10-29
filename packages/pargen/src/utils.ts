export type TokenMap<T extends string> = Record<T, Array<number>>;

type StringMatcher = (input: string, pos: number) => string | null;

export const isNumber = (x: any): x is number => typeof x === "number";
export const isString = (x: any): x is number => typeof x === "string";

export function buildRangesToString(
  input: string,
  ranges: Array<[number, number] | string>
): string {
  return ranges
    .map((range) => {
      if (typeof range === "string") {
        return range;
      } else {
        return input.slice(range[0], range[1]);
      }
    })
    .join("");
}

const REGEX_CHAR =
  /(?<!\\)[\(\)\[\]\+\?\+\^\*\.]|(\\[dDsSwWbB])|\{(\d*),?\d*\}/;

// regex
export function isRegExp(str: string) {
  return REGEX_CHAR.test(str);
}

export function createRegexMatcher(expr: string): StringMatcher {
  const regex = new RegExp(`^(${expr})`, "ms");
  return (input: string, pos: number) => findPatternAt(input, regex, pos);
}

export function createStringMatcher(expr: string): StringMatcher {
  const escapedExpr = expr
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\/g, "");
  return (input: string, pos: number) => {
    if (startStringAt(input, escapedExpr, pos)) {
      return escapedExpr;
    }
    return null;
  };
}

export function createMatcher(expr: string): StringMatcher {
  if (isRegExp(expr)) {
    return createRegexMatcher(expr);
  } else {
    return createStringMatcher(expr);
  }
}

const findPatternAt = (
  input: string,
  regex: RegExp,
  pos: number
): string | null => {
  const sliced = input.slice(pos);
  const match = sliced.match(regex);
  if (match && match[0].length > 0) {
    // const regexSummary =
    //   regex.toString().length > 10
    //     ? regex.toString().slice(0, 10) + "..."
    //     : regex;
    // console.log(`[eat:reg${regexSummary}]`, `"${match[0]}"`);
  }
  return match?.[0] ?? null;
};

const startStringAt = (input: string, str: string, pos: number): boolean => {
  const match = input.startsWith(str, pos);
  if (match && input.length > 0) {
    // console.log("[eat:str]", `"${str.slice(0, 10)}"`);
  } else {
    // console.log("[eat:str_fail]", str);
  }
  return match;
};

export function buildTokenMap<T extends string>(
  text: string,
  readChars: Array<T>
): TokenMap<T> {
  const chars = Array.from(text);
  const map: TokenMap<T> = readChars.reduce(
    (acc, char) => ({ ...acc, [char]: [] }),
    {} as TokenMap<T>
  );

  for (let i = 0; i < chars.length; i++) {
    const char = text[i];
    if (readChars.includes(char as T)) {
      map[char as T].push(i);
    }
  }
  return map;
}

export function preparse(text: string): Array<string[]> {
  const lines: Array<string[]> = [];
  let braceStack = 0;
  let parenStack = 0;
  const isStackClean = () => braceStack === 0 && parenStack === 0;

  let _buf = "";
  let _tokens: string[] = [];

  const pushChar = (char: string) => {
    if (_buf === " " && ["\n", "\t", " "].includes(char)) {
      return;
    }
    if (_buf.length === 0 && char === "\n") {
      return;
    }
    _buf += char;
  };

  const finishToken = (next?: string) => {
    if (next) {
      pushChar(next);
    }

    if (_buf.length > 0) {
      _tokens.push(_buf);
    }
    _buf = "";
  };

  const finishLine = () => {
    finishToken();
    if (_tokens.length) {
      // lines.push(_tokens.join(""));
      lines.push(_tokens);
      _tokens = [];
      _buf = "";
    }
  };

  // let isString = '';
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    switch (char) {
      case " ": {
        // tokenize finish
        finishToken();
        break;
      }
      case ";": {
        finishToken();
        isStackClean() && finishLine();
        break;
      }
      // support next line;
      case "}": {
        finishToken();
        finishToken(char);
        braceStack--;
        // pushChar(char);
        if (isStackClean() && chars[i + 1] === "\n") {
          finishLine();
          // skip next newLine
          i++;
        }
        break;
      }
      case "(":
        parenStack++;
        finishToken();
        finishToken(char);
        break;
      case ")":
        parenStack--;
        finishToken();
        finishToken(char);
        break;
      case "{":
        braceStack++;
        finishToken();
        finishToken(char);
        break;
      default: {
        pushChar(char);
      }
    }
  }

  finishLine();
  return lines;
}

export function readPairedBlock(
  tokenMap: TokenMap<any>,
  pos: number,
  max: number,
  [start, end]: [start: string, end: string]
): number | void {
  const startList = tokenMap[start];
  const endList = tokenMap[end];
  let stack = 0;

  if (pos !== startList[0]) {
    // not opend as first char
    return;
  }

  for (let i = pos; i < max; i++) {
    if (startList.includes(i)) {
      stack++;
    }
    if (endList.includes(i)) {
      stack--;
    }
    if (stack === 0) {
      return i + Array.from(end).length;
    }
  }
}

import { test, run } from "@mizchi/test";
const isMain = require.main === module;
if (process.env.NODE_ENV === "test") {
  const assert = require("assert");
  // @ts-ignore
  const eq = (...args: any[]) => assert.deepStrictEqual(...(args as any));

  test("preparse", () => {
    const text = "a;bb;{a};{}\nccc;\nfunction(){}";
    const lines = preparse(text);
    console.log("lines", lines);
    eq(lines, [
      ["a"],
      ["bb"],
      ["{", "a", "}"],
      ["{", "}"],
      ["ccc"],
      ["function", "(", ")", "{", "}"],
    ]);
  });

  test("buildTokenMap & pair", () => {
    const text = "( { { a } } ) [ ]";
    const chars = ["(", ")", "{", "}", "[", "]"];
    const map = buildTokenMap(text, chars);
    // console.log(map);
    eq(map, {
      "(": [0],
      ")": [12],
      "{": [2, 4],
      "}": [8, 10],
      "[": [14],
      "]": [16],
    });
    const hit = readPairedBlock(map, 0, text.length, ["(", ")"]);
    eq(text.slice(0, hit as number), "( { { a } } )");

    const hit2 = readPairedBlock(map, 2, text.length, ["{", "}"]);
    eq(text.slice(2, hit2 as number), "{ { a } }");
  });

  test("findPatternAt", () => {
    eq(createMatcher("a")("a", 0), "a");
    eq(createMatcher("\\w+")("abc", 0), "abc");
    eq(createMatcher("a\nb")("a\nb", 0), "a\nb");
    eq(createMatcher("\nb")("a\nb", 1), "\nb");
    eq(createMatcher("\\sb")("a\nb", 1), "\nb");
    eq(createMatcher("\\[")("[", 0), "[");
    eq(createMatcher("\\a")("a", 0), "a");
    eq(createMatcher("\n")("\n", 0), "\n");
    eq(createMatcher("\\[\\]")("[]", 0), "[]");
  });

  test("findPatternAt2", () => {
    const code = `

    aaa
bb

ccc
    `;
    const hit = code.indexOf("ccc");
    eq(createMatcher("ccc")(code, hit), "ccc");
  });

  test("isRegExp", () => {
    eq(isRegExp(" "), false);
    eq(isRegExp("a"), false);
    eq(isRegExp("token_exp"), false);
    eq(isRegExp("("), true);
    eq(isRegExp(")"), true);
    eq(isRegExp("."), true);
    eq(isRegExp("+"), true);
    eq(isRegExp("?"), true);
    eq(isRegExp(":"), false);
    eq(isRegExp("\\."), false);
    eq(isRegExp("\\+"), false);
    eq(isRegExp("\\a"), false);
    eq(isRegExp("\\["), false);
    eq(isRegExp("\\]"), false);
    eq(isRegExp("\\d"), true);
    eq(isRegExp("\\w"), true);
    eq(isRegExp("\\W"), true);
    eq(isRegExp("\\s"), true);
    eq(isRegExp("\\S"), true);
    eq(isRegExp("\\s"), true);
    eq(isRegExp("{"), false);
    eq(isRegExp("}"), false);
    eq(isRegExp("{1}"), true);
    eq(isRegExp("{1,}"), true);
    eq(isRegExp("{1,2}"), true);
    eq(isRegExp("{,3}"), true);
    eq(isRegExp("{,3"), false);
    eq(isRegExp("+"), true);
    eq(isRegExp("\\s+"), true);
    eq(isRegExp("\\+\\+"), false);
  });

  run({ stopOnFail: true, stub: true, isMain });
}
