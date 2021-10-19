import {
  PackratCache,
  Rule,
  ParseResult,
  Compiler,
  RootParser,
  ParseContext,
  ErrorType,
  NodeKind,
  ParseSuccess,
  ParseError,
  CacheMap,
  InternalPerser,
  RootCompiler,
  Not,
  Ref,
  Atom,
  Token,
  Or,
  Repeat,
  Seq,
  defaultReshape,
  Range,
} from "./types";
import { buildTokenMap, findPatternAt } from "./utils";

// impl
function createPackratCache(): PackratCache {
  const cache: CacheMap = {};
  const keygen = (id: Rule["id"], pos: number): `${number}@${string}` =>
    `${pos}@${id}`;
  return {
    export(): CacheMap {
      return cache;
    },
    add(id: Rule["id"], pos: number, result: ParseResult) {
      // @ts-ignore
      cache[keygen(id, pos)] = result;
    },
    get(id: Rule["id"], pos: number): ParseResult | void {
      const key = keygen(id, pos);
      return cache[key];
    },
  };
}

export function createCompiler<ID extends number>(
  partial: Partial<Compiler<ID>>
): Compiler<ID> {
  const compiler: Compiler<ID> = {
    pairs: [],
    composeTokens: true,
    refs: {} as any,
    rules: {},
    patterns: {},
    ...partial,
    compile: null as any,
  };

  // internal
  const compile: RootCompiler<ID> = (node) => {
    const resolved = typeof node === "number" ? createRef(node) : node;
    const parse = compileParser(resolved, compiler);
    const parser: RootParser = (
      input: string,
      ctx: Partial<ParseContext> = {}
    ) => {
      const cache = createPackratCache();
      const tokenMap = buildTokenMap(input, compiler.pairs);
      return parse(input, {
        cache: cache,
        pos: 0,
        tokenMap,
        ...ctx,
      });
    };
    return parser;
  };

  const rootCompiler: RootCompiler<ID> = (node, rootOpts) => {
    const end = rootOpts?.end ?? false;
    const resolved = typeof node === "number" ? createRef(node) : node;
    const out = end
      ? ({
          id: "entry:" + Math.random().toString(),
          kind: NodeKind.SEQ,
          primitive: true,
          children: [
            resolved,
            {
              id: "eof:" + Math.random().toString(),
              kind: NodeKind.EOF,
              primitive: true,
            },
          ],
        } as Seq)
      : resolved;
    return compile(out);
  };
  compiler.compile = rootCompiler;
  return compiler;
}

export function createContext<ID extends number = number>(
  partialOpts: Partial<Compiler<ID>> = {}
) {
  const ctx = createCompiler(partialOpts);
  const builder = createBuilder(ctx);
  return { builder, compile: ctx.compile };
}

const getOrCreateCache = (
  cache: PackratCache,
  id: string,
  pos: number,
  creator: () => ParseResult
): ParseResult => {
  const cached = cache.get(id, pos);
  if (cached) return cached;
  const result = creator();
  cache.add(id, pos, result);
  return result;
};

export const createParseSuccess = (
  result: any,
  pos: number,
  len: number,
  ranges: Range[] = [[pos, pos + len]]
) => {
  return {
    error: false,
    result,
    len,
    pos,
    ranges,
  } as ParseSuccess;
};

export const createParseError = <ET extends ErrorType>(
  kind: NodeKind,
  errorType: ET,
  pos: number,
  detail?: any
): ParseError => {
  return {
    error: true,
    kind,
    errorType,
    pos,
    detail,
  };
};

export function compileParser(
  rule: Rule,
  compiler: Compiler<any>
): InternalPerser {
  const reshape = rule.reshape ?? defaultReshape;

  if (!rule.primitive && compiler.rules[rule.kind]) {
    // @ts-ignore
    const parse = compiler.rules[rule.kind](rule, compiler);
    return ((input, ctx) => {
      return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
        // @ts-ignore
        return parse(input, ctx);
      });
    }) as InternalPerser;
  }

  switch (rule.kind) {
    case NodeKind.NOT: {
      const childParser = compileParser((rule as Not).child, compiler);
      return (input, ctx) => {
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
          const result = childParser(input, ctx);
          if (result.error === true) {
            return createParseSuccess(result, ctx.pos, 0);
          }
          return createParseError(
            rule.kind,
            ErrorType.Not_IncorrectMatch,
            ctx.pos,
            result.len
          );
        });
      };
    }

    case NodeKind.REF: {
      return (input, ctx) => {
        const resolved = compiler.patterns[(rule as Ref).ref];
        if (!resolved) {
          throw new Error(`symbol not found: ${(rule as Ref).ref}`);
        }
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () =>
          resolved!(input, ctx)
        );
      };
    }

    case NodeKind.ATOM: {
      // const node = node as Atom;
      const parse = (rule as Atom).parse({} as any, compiler);
      return (input, ctx) => {
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
          const ret = parse(input, ctx);
          if (ret == null) {
            return createParseError(
              rule.kind,
              ErrorType.Atom_ParseError,
              ctx.pos
            );
          }
          if (typeof ret === "number") {
            return createParseSuccess(
              input.slice(ctx.pos, ctx.pos + ret),
              ctx.pos,
              ret
            );
          }
          const [out, len] = ret;
          return createParseSuccess(out, ctx.pos, len);
        });
      };
    }

    case NodeKind.EOF: {
      return (input: string, ctx) => {
        const ended = Array.from(input).length === ctx.pos;
        if (ended) {
          return createParseSuccess("", ctx.pos, 0);
        }
        return createParseError(rule.kind, ErrorType.Eof_Unmatch, ctx.pos);
      };
    }

    case NodeKind.TOKEN: {
      return (input: string, ctx) => {
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
          const cached = ctx.cache.get(rule.id, ctx.pos);
          if (cached) return cached;
          const matched = findPatternAt(input, (rule as Token).expr, ctx.pos);
          // console.log("[eat] matched", {
          //   input: input.slice(ctx.pos),
          //   expr: node.expr,
          //   // pos: ctx.pos,
          //   matched,
          // });
          if (matched == null) {
            if (rule.optional) {
              return createParseSuccess(null, ctx.pos, 0);
            } else {
              return createParseError(
                rule.kind,
                ErrorType.Token_Unmatch,
                ctx.pos,
                `"${input.slice(ctx.pos)}" does not fill: ${
                  (rule as Token).expr
                }`
              );
            }
          }
          return createParseSuccess(
            reshape(matched),
            ctx.pos,
            Array.from(matched).length
          );
        });
      };
    }
    case NodeKind.OR: {
      const compiledPatterns = (rule as Or).patterns.map((p) => {
        return {
          parse: compileParser(p, compiler),
          node: p,
        };
      });
      return (input: string, ctx) => {
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
          const errors: ParseError[] = [];
          for (const next of compiledPatterns) {
            const parsed = next.parse(input, ctx);
            if (parsed.error === true) {
              if (rule.optional) {
                return createParseSuccess(null, ctx.pos, 0);
              }
              errors.push(parsed);
              continue;
            }
            return parsed as ParseResult;
          }
          return createParseError(rule.kind, ErrorType.Or_UnmatchAll, ctx.pos, {
            message: `"${input.slice(ctx.pos)}" does not match any pattern`,
            children: errors,
          });
        });
      };
    }
    case NodeKind.REPEAT: {
      const parser = compileParser((rule as Repeat).pattern, compiler);
      return (input: string, opts) => {
        return getOrCreateCache(opts.cache, rule.id, opts.pos, () => {
          const repeat = rule as Repeat;
          const xs: string[] = [];
          let ranges: Range[] = [];
          let cursor = opts.pos;
          while (cursor < input.length) {
            const parseResult = parser(input, { ...opts, pos: cursor });
            // console.log("[eat]", match);
            if (parseResult.error === true) break;
            // stop infinite loop
            if (parseResult.len === 0) {
              throw new Error(`Zero offset repeat item is not allowed`);
            }
            xs.push(parseResult.result);
            ranges.push(...parseResult.ranges);
            cursor += parseResult.len;
          }
          // size check
          // TODO: detect max at adding
          if (
            xs.length < repeat.min ||
            // @ts-ignore
            (repeat.max && xs.length > repeat.max)
          ) {
            return createParseError(
              rule.kind,
              ErrorType.Repeat_RangeError,
              opts.pos,
              `not fill range: ${xs.length} in [${repeat.min}, ${
                repeat.max ?? ""
              }] `
            );
          }
          return createParseSuccess(
            xs.map(reshape as any),
            opts.pos,
            cursor - opts.pos,
            ranges
          );
        });
      };
    }
    case NodeKind.SEQ: {
      let isObjectMode = false;
      const parsers = (rule as Seq).children.map((c) => {
        const parse = compileParser(c, compiler);
        if (c.key) isObjectMode = true;
        return { parse, node: c };
      });
      return (input: string = "", ctx) => {
        return getOrCreateCache(ctx.cache, rule.id, ctx.pos, () => {
          let cursor = ctx.pos;
          if (isObjectMode) {
            const result: any = {};
            for (const parser of parsers) {
              const parseResult = parser.parse(input, { ...ctx, pos: cursor });
              if (parseResult.error) {
                if (parser.node.optional) continue;
                return createParseError(
                  rule.kind,
                  ErrorType.Seq_Stop,
                  ctx.pos,
                  {
                    child: parseResult,
                  }
                );
              }
              if (parser.node.key && !parser.node.skip) {
                const reshaped = parseResult.result;
                result[parser.node.key] = reshaped;
              }
              // step cursor
              cursor += parseResult.len;
            }
            const reshaped = reshape(result);
            return createParseSuccess(reshaped, ctx.pos, cursor - ctx.pos);
          } else {
            // string mode
            // let eaten = "";
            let ranges: Range[] = [];
            for (const parser of parsers) {
              const parseResult = parser.parse(input, { ...ctx, pos: cursor });
              if (parseResult.error) {
                if (parser.node.optional) continue;
                return createParseError(
                  rule.kind,
                  ErrorType.Seq_Stop,
                  ctx.pos,
                  {
                    child: parseResult,
                  }
                );
              }
              // WIP: Skip
              if (!parser.node.skip) {
                ranges.push(...parseResult.ranges);
              }
              cursor += parseResult.len;
            }
            const text = ranges
              .map(([start, end]) => input.slice(start, end))
              .join("");
            // console.log("input", text);
            return createParseSuccess(
              reshape(text),
              ctx.pos,
              cursor - ctx.pos,
              ranges
            );
          }
        });
      };
    }
    default: {
      console.log(rule);
      throw new Error("WIP expr and parser");
    }
  }
}

import { test, run, is } from "@mizchi/test";
import { createBuilder, createRef } from "./builder";
if (process.env.NODE_ENV === "test" && require.main === module) {
  test("whitespace", () => {
    const { compile, builder: $ } = createContext();
    is(compile($.tok("\\s+"))(" ").result, " ");
    is(compile($.tok("(\\s+)?"))("").result, "");
    is(compile($.tok("(\\s+)?"))("  ").result, "  ");
    is(compile($.tok("(\\s+)?"))(" \n ").result, " \n ");
    is(compile($.tok("(\\s+)?"))(" \t ").result, " \t ");
  });

  test("token", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq(["a"]));
    is(parser("a").result, "a");
  });

  test("token2", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.tok("\\s*a"));
    is(parser("a").result, "a");
    is(parser(" a").result, " a");
    is(parser("  y").error, true);
  });

  test("nested-token", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq(["a", $.seq(["b", "c"])]));
    is(parser("abc").result, "abc");
    is(parser("adb").error, true);
  });

  test("not", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq([$.not("a"), "\\w", $.not("b"), "\\w"]));
    is(parser("ba").result, "ba");
    is(parser("ab").error, true);
    is(parser("aa").error, true);
    is(parser("bb").error, true);
  });

  test("seq-shorthand", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.seq([
      ["a", "x"],
      ["b", "y"],
    ]);
    const parser = compile(seq);
    is(parser("xy"), {
      result: { a: "x", b: "y" },
      len: 2,
      pos: 0,
    });
  });

  test("seq", () => {
    const { compile, builder: $ } = createContext();

    const seq = $.seq([$.param("a", "x"), $.param("b", "y")]);
    const parser = compile(seq);
    is(parser("xy"), {
      result: { a: "x", b: "y" },
      len: 2,
      pos: 0,
    });
    is(parser("xyz"), {
      result: { a: "x", b: "y" },
      len: 2,
      pos: 0,
    });
    is(parser("xz"), {
      error: true,
      errorType: ErrorType.Seq_Stop,
      pos: 0,
      detail: {
        child: {
          pos: 1,
          detail: '"z" does not fill: y',
          error: true,
          errorType: ErrorType.Token_Unmatch,
        },
      },
    });
    is(parser(" xy"), {
      error: true,
      errorType: ErrorType.Seq_Stop,
      pos: 0,
      detail: {
        child: {
          error: true,
          pos: 0,
          errorType: ErrorType.Token_Unmatch,
          detail: '" xy" does not fill: x',
        },
      },
    });
  });

  test("seq:skip", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq(["a", $.skip("\\s*"), "b"]));
    is(parser("a   b").result, "ab");
  });

  test("seq:skip_opt", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile(
      $.seq(["a", $.skip_opt($.seq(["\\:", "@"])), "=", "b"])
      // { end: true }
    );
    is(parser("a=b"), { result: "a=b" });
    is(parser("a:@=b"), { result: "a=b" });
  });

  test("seq:eof", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq(["a", $.eof()]));
    // console.log("parse", parser("a"));
    is(parser("a").result, "a");
    is(parser("a ").error, true);

    const parser2 = compile($.seq([$.eof()]));
    is(parser2("").result, "");
  });

  test("seq:eof-eof", () => {
    const { compile, builder: $ } = createContext({
      composeTokens: false,
    });
    const parser = compile(
      $.repeat(
        $.seq([
          // a
          "a",
          $.or(["[\\n]", $.eof()]),
        ])
      )
    );
    is(parser("a\na\na"), { result: ["a\n", "a\n", "a"] });
  });

  test("seq-with-param", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.seq([$.param("a", "a")]);
    const parser = compile(seq);

    is(parser("a"), { result: { a: "a" }, len: 1, pos: 0 });
    is(parser("ab"), {
      result: { a: "a" },
      len: 1,
      pos: 0,
    });
    is(parser("x"), {
      error: true,
      errorType: ErrorType.Seq_Stop,
      pos: 0,
      detail: {
        child: {
          pos: 0,
          error: true,
          errorType: ErrorType.Token_Unmatch,
          detail: `"x" does not fill: a`,
        },
      },
    });
  });

  test("reuse symbol", () => {
    enum T {
      _,
    }
    const { compile, builder: $ } = createContext({ refs: T });
    $.def(T._, $.tok("\\s"));

    const seq = $.seq(["a", T._, "b", T._, "c"]);
    const parser = compile(seq);
    is(parser("a b c"), {
      result: "a b c",
      len: 5,
      pos: 0,
    });
  });

  test("repeat", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.repeat(
      $.seq([
        ["a", "x"],
        ["b", "y"],
      ])
    );
    const parser = compile(seq);
    is(parser(""), {
      error: false,
      result: [],
      pos: 0,
      len: 0,
    });
    is(parser("xy"), {
      error: false,
      result: [{ a: "x", b: "y" }],
      pos: 0,
      len: 2,
    });
    is(parser("xyxy"), {
      error: false,
      result: [
        { a: "x", b: "y" },
        { a: "x", b: "y" },
      ],
      pos: 0,
      len: 4,
    });
    is(parser("xyxz"), {
      error: false,
      result: [{ a: "x", b: "y" }],
      pos: 0,
      len: 2,
    });
    is(parser("xzxy"), {
      result: [],
      pos: 0,
      len: 0,
      error: false,
    });
  });

  test("repeat:str", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.repeat_seq(["a", "b", $.eof()]));
    is(parser("ab"), {
      error: false,
      result: ["ab"],
      pos: 0,
      len: 2,
    });
    const parser2 = compile(
      $.seq([$.repeat($.seq(["a", "b", $.eof()])), "\\s*"])
    );
    is(parser2("ab"), {
      error: false,
      result: "ab",
      pos: 0,
      len: 2,
    });
  });

  test("repeat:minmax", () => {
    const { compile, builder: $ } = createContext();
    const rep = $.repeat($.seq(["xy"]), [1, 2]);
    const parser = compile(rep);
    // 1
    is(parser("xy"), {
      error: false,
      result: ["xy"],
      len: 2,
    });

    // 2
    is(parser("xyxy"), {
      error: false,
      result: ["xy", "xy"],
      len: 4,
    });
    // range out
    // 0
    is(parser(""), { error: true });
    // 3
    is(parser("xyxyxy"), { error: true });
  });

  test("repeat:direct-repeat", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.repeat($.seq(["ab"]), [1, 2]));
    is(parser("ab"), {
      result: ["ab"],
      pos: 0,
      len: 2,
    });
    is(parser("abab"), {
      result: ["ab", "ab"],
      pos: 0,
      len: 4,
    });
  });

  test("seq:multiline", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.seq(["aaa\\sbbb"]);
    const parser = compile(seq);
    is(parser(`aaa\nbbb`), {
      result: "aaa\nbbb",
      len: 7,
      pos: 0,
    });
  });

  test("seq:opt", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.seq(["a", $.opt("b"), "c"]);
    const parser = compile(seq);
    is(parser(`abc`), {
      result: "abc",
      len: 3,
      pos: 0,
    });
    is(parser(`ac`), {
      result: "ac",
      len: 2,
      pos: 0,
    });
  });

  test("repeat", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.repeat(
      $.seq([
        ["a", "x"],
        ["b", "y"],
      ])
    );
    const parser = compile(seq);
    is(parser("xy"), {
      result: [{ a: "x", b: "y" }],
      pos: 0,
      len: 2,
    });
    is(parser("xyxy"), {
      result: [
        { a: "x", b: "y" },
        { a: "x", b: "y" },
      ],
      pos: 0,
      len: 4,
    });
    is(parser("xyxz"), {
      result: [{ a: "x", b: "y" }],
      pos: 0,
      len: 2,
    });
    is(parser("xzxy"), { result: [], pos: 0, len: 0 });
  });

  test("repeat:with-padding", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.seq([
      "_+",
      $.param(
        "xylist",
        $.repeat(
          $.seq([
            ["a", "x"],
            ["b", "y"],
          ])
        )
      ),
      "_+",
    ]);
    const parser = compile(seq);

    is(parser("__xyxy_"), {
      result: {
        xylist: [
          { a: "x", b: "y" },
          { a: "x", b: "y" },
        ],
      },
      pos: 0,
      len: 7,
    });
  });

  test("or", () => {
    const { compile, builder: $ } = createContext();

    const seq = $.or(["x", "y"]);
    const parser = compile(seq);
    is(parser("x"), {
      result: "x",
      len: 1,
    });
    is(parser("y"), {
      result: "y",
      len: 1,
    });
    is(parser("z"), {
      error: true,
      errorType: ErrorType.Or_UnmatchAll,
      pos: 0,
      detail: {
        message: '"z" does not match any pattern',
        children: [
          {
            error: true,
            pos: 0,
            errorType: ErrorType.Token_Unmatch,
            detail: '"z" does not fill: x',
          },
          {
            error: true,
            pos: 0,
            errorType: ErrorType.Token_Unmatch,
            detail: '"z" does not fill: y',
          },
        ],
      },
    });
  });

  test("or:with-cache", () => {
    const { compile, builder: $ } = createContext();
    const seq = $.or([$.seq(["x", "y", "z"]), $.seq(["x", "y", "a"])]);
    const parser = compile(seq);
    is(parser("xya"), {
      result: "xya",
      len: 3,
      pos: 0,
    });
    // console.log("xyb", JSON.stringify(parser("xyb"), null, 2));
    is(parser("xyb"), {
      error: true,
      pos: 0,
      errorType: ErrorType.Or_UnmatchAll,
      detail: {
        message: '"xyb" does not match any pattern',
        children: [
          {
            error: true,
            errorType: ErrorType.Seq_Stop,
            pos: 0,
            detail: {
              child: {
                error: true,
                pos: 0,
                errorType: ErrorType.Token_Unmatch,
                detail: '"xyb" does not fill: xyz',
              },
            },
          },
          {
            error: true,
            errorType: ErrorType.Seq_Stop,
            pos: 0,
            detail: {
              child: {
                error: true,
                pos: 0,
                errorType: ErrorType.Token_Unmatch,
                detail: '"xyb" does not fill: xya',
              },
            },
          },
        ],
      },
    });
  });

  test("reuse recursive with suffix", () => {
    enum E {
      Paren,
    }
    const { compile, builder: $ } = createContext({
      refs: E,
    });
    const paren = $.def(
      E.Paren,
      $.seq([
        "\\(",
        $.or([
          // nested: ((1))
          $.ref(E.Paren),
          // (1),
          "1",
        ]),
        "\\)",
      ])
    );
    const parser = compile($.ref(paren));
    // console.log("compile success");
    is(parser("(1)_"), { result: "(1)", len: 3, pos: 0 });
    is(parser("((1))"), {
      result: "((1))",
      len: 5,
      pos: 0,
    });
    is(parser("(((1)))"), {
      result: "(((1)))",
      len: 7,
      pos: 0,
    });
    is(parser("((((1))))"), {
      result: "((((1))))",
      len: 9,
      pos: 0,
    });
    is(parser("((1)").error, true);
  });

  test("pair", () => {
    const { compile, builder: $ } = createContext({
      pairs: ["<", ">"],
    });
    const parser = compile($.pair({ open: "<", close: ">" }));
    is(parser("<>").result, "<>");
    is(parser("<<>>").result, "<<>>");
    is(parser("<<>").error, true);
    is(parser("<<a>").error, true);
    is(parser(">").error, true);
    is(parser("").error, true);
  });

  test("atom", () => {
    const { compile, builder: $ } = createContext();
    // read next >
    const parser = compile(
      $.atom((_node, _opts) => {
        return (input, ctx) => {
          const char = input.indexOf(">", ctx.pos);
          if (char === -1) {
            return;
          }
          return char + 1;
        };
      })
    );
    is(parser("<>").result, "<>");
    is(parser("< >").result, "< >");
  });

  test("atom:shape", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile(
      $.atom((_node, _opts) => {
        return (input, ctx) => {
          const char = input.indexOf(">", ctx.pos);
          if (char === -1) {
            return;
          }
          return [{ atom: "x" }, 2];
        };
      })
    );
    is(parser("<>").result, {
      atom: "x",
    });
  });

  test("seq:skip-nested", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq(["a", $.seq([$.skip("b"), "c"])]));
    is(parser("abc"), { result: "ac" });
  });
  test("seq:skip-nested2", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.or([$.seq([$.skip("b")])]));
    is(parser("b"), { result: "" });
  });
  test("seq:skip-nested3-optional", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.or([$.seq([$.skip_opt("b")])]));
    is(parser("b"), { result: "" });
    is(parser(""), { result: "" });
  });

  // test("skip with eof", () => {
  //   const { compile, builder: $ } = createContext();
  //   const parserNoEof = compile($.seq(["a", $.skip("b"), "c"]));
  //   is(parserNoEof("abc"), { result: "ac" });
  //   const parser = compile($.seq(["a", $.skip("b"), "c", $.eof()]));
  //   is(parser("abc"), { result: "ac" });
  // });

  test("skip with repeat", () => {
    const { compile, builder: $ } = createContext();
    const parser = compile($.seq([$.repeat_seq(["a", $.skip("b")])]));
    is(parser("ababab"), { result: "aaa" });
  });

  run({ stopOnFail: true, stub: true });
}