import {
  ATOM,
  Compiler,
  EOF,
  ERROR_Eof_Unmatch,
  ERROR_Not_IncorrectMatch,
  ERROR_Or_UnmatchAll,
  ERROR_Regex_Unmatch,
  ERROR_Repeat_RangeError,
  ERROR_Seq_Stop,
  ERROR_Token_Unmatch,
  InternalParser,
  NOT,
  OR,
  ParseError,
  ParseErrorData,
  ParseResult,
  ParseSuccess,
  Range,
  REF,
  REGEX,
  REPEAT,
  Repeat,
  Reshape,
  Rule,
  SEQ,
  TOKEN,
} from "./types";
import {
  buildRangesToString,
  createRegexMatcher,
  createStringMatcher,
} from "./utils";

export const createParseSuccess = (
  result: any,
  pos: number,
  len: number,
  ranges: (Range | string)[] = [[pos, pos + len]],
  reshape?: Reshape
  // hasReshaper: boolean = false
) => {
  let newRanges: (Range | string)[] = [];
  // console.log("createSuccess:raw", ranges);
  if (ranges.length > 0) {
    // let start = ranges[0][0];
    newRanges = ranges.reduce((acc, range, index) => {
      // first item
      if (index === 0) return [range];
      if (typeof range === "string") {
        return [...acc, range] as (Range | string)[];
      }
      const [nextStart, nextEnd] = range;
      // omit [a,a]
      if (nextStart === nextEnd) return acc;
      const last = acc.slice(-1)[0];
      if (typeof last === "string") {
        return [...acc, range];
      }
      if (last[1] === nextStart) {
        // lastStart => newEnd
        return [...acc.slice(0, -1), [last[0], nextEnd]];
      }
      return [...acc, [nextStart, nextEnd]];
    }, [] as (Range | string)[]);
  }
  // console.log("createSuccess:raw", ranges, "=>", newRanges);

  return {
    error: false,
    result: reshape ? reshape(result) : result,
    len,
    pos,
    ranges: newRanges,
    reshaped: !!reshape,
  } as ParseSuccess;
};

export function createParseError<ErrorData extends ParseErrorData>(
  rule: Rule,
  pos: number,
  rootId: number,
  errorData: ErrorData
): ParseError {
  return {
    error: true,
    rootId,
    // rule,
    pos,
    ...errorData,
  };
}

export function compileFragment(
  rule: Rule,
  compiler: Compiler,
  rootId: number
): InternalParser {
  const internalParser = compileFragmentInternal(rule, compiler, rootId);
  // generic cache
  const parser: InternalParser = (ctx, pos) => {
    return ctx.cache.getOrCreate(rule.id, pos, () => {
      return internalParser(ctx, pos);
    });
  };
  return parser;
}

function compileFragmentInternal(
  rule: Rule,
  compiler: Compiler,
  rootId: number
): InternalParser {
  switch (rule.kind) {
    case NOT: {
      const childParser = compileFragment(rule.child, compiler, rootId);
      return (ctx, pos) => {
        const result = childParser(ctx, pos);
        if (result.error === true) {
          return createParseSuccess(result, pos, 0, undefined, rule.reshape);
        }
        return createParseError(rule, pos, rootId, {
          errorType: ERROR_Not_IncorrectMatch,
        });
      };
    }
    case REF: {
      return (ctx, pos) => {
        const resolved = compiler.parsers.get(rule.ref);
        return resolved!(ctx, pos);
      };
    }
    case ATOM: {
      return (ctx, pos) => {
        return rule.parse(ctx, pos);
      };
    }

    case EOF: {
      return (ctx, pos) => {
        const ended = Array.from(ctx.raw).length === pos;
        if (ended) {
          return createParseSuccess("", pos, 0, undefined, rule.reshape);
        }
        return createParseError(rule, pos, rootId, {
          errorType: ERROR_Eof_Unmatch,
        });
      };
    }

    case REGEX: {
      let expr = rule.expr;
      const matcher = createRegexMatcher(expr);
      return (ctx, pos) => {
        const matched: string | null = matcher(ctx.raw, pos);
        if (matched == null) {
          if (rule.optional) {
            return createParseSuccess(null, pos, 0, undefined, rule.reshape);
          } else {
            return createParseError(rule, pos, rootId, {
              errorType: ERROR_Regex_Unmatch,
              expr: expr,
            });
          }
        }
        return createParseSuccess(
          matched,
          pos,
          Array.from(matched).length,
          undefined,
          rule.reshape
        );
      };
    }

    case TOKEN: {
      let expr = rule.expr;
      const matcher = createStringMatcher(expr);
      return (ctx, pos) => {
        const matched: string | null = matcher(ctx.raw, pos);
        if (matched == null) {
          if (rule.optional) {
            return createParseSuccess(null, pos, 0, undefined, rule.reshape);
          } else {
            return createParseError(rule, pos, rootId, {
              errorType: ERROR_Token_Unmatch,
            });
          }
        }
        return createParseSuccess(
          matched,
          pos,
          Array.from(matched).length,
          undefined,
          rule.reshape
        );
      };
    }
    case OR: {
      // const heads = rule.heads;
      const compiledHeads = rule.heads.map((p) => {
        return {
          parse: compileFragment(p, compiler, rootId),
          node: p,
        };
      });

      const compiledPatterns = rule.patterns.map((p) => {
        return {
          parse: compileFragment(p, compiler, rootId),
          node: p,
        };
      });
      return (ctx, pos) => {
        const headErrors = [];
        // if heads is 0, return success
        if (compiler.useHeadTables && compiledHeads.length > 0) {
          let isHeadSuccess = false;
          for (const head of compiledHeads) {
            const parsed = head.parse(ctx, pos);
            if (parsed.error) {
              // TODO: Cache
              headErrors.push(parsed);
            } else {
              isHeadSuccess = true;
            }
          }
          if (!isHeadSuccess) {
            if (rootId === 15) {
              console.log("fail to parse head", headErrors);
            }
            return createParseError(rule, pos, rootId, {
              errorType: ERROR_Or_UnmatchAll,
              errors: headErrors,
            });
          }
        }

        const errors: ParseError[] = [];
        for (const next of compiledPatterns) {
          const parsed = next.parse(ctx, pos);
          // console.log("parsed:or", parsed);
          if (parsed.error === true) {
            if (rule.optional) {
              return createParseSuccess(null, pos, 0, undefined, rule.reshape);
            }
            errors.push(parsed);
            continue;
          }
          return parsed as ParseResult;
        }
        return createParseError(rule, pos, rootId, {
          errorType: ERROR_Or_UnmatchAll,
          errors,
        });
      };
    }
    case REPEAT: {
      const parser = compileFragment(rule.pattern, compiler, rootId);
      return (ctx, pos) => {
        const repeat = rule as Repeat;
        const xs: string[] = [];
        let ranges: (Range | string)[] = [];
        let cursor = pos;
        while (cursor < Array.from(ctx.raw).length) {
          const parseResult = parser(ctx, cursor);
          if (parseResult.error === true) break;
          // stop infinite loop
          if (parseResult.len === 0) {
            throw new Error(`ZeroRepeat`);
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
          return createParseError(rule, pos, rootId, {
            errorType: ERROR_Repeat_RangeError,
          });
        }
        return createParseSuccess(
          rule.reshape ? xs.map(rule.reshape as any) : xs,
          pos,
          cursor - pos,
          ranges
          // rule.reshape
        );
      };
    }
    case SEQ: {
      let isObjectMode = false;
      // let hasSkip = false;
      const parsers = rule.children.map((c) => {
        const parse = compileFragment(c, compiler, rootId);
        if (c.key) isObjectMode = true;
        // if (c.skip) hasSkip = true;
        return { parse, node: c };
      });
      return (ctx, pos) => {
        let cursor = pos;
        if (isObjectMode) {
          const result: any = {};
          for (const parser of parsers) {
            const parseResult = parser.parse(ctx, cursor);
            if (parseResult.error) {
              if (parser.node.optional) continue;
              return createParseError(rule, cursor, rootId, {
                errorType: ERROR_Seq_Stop,
                childError: parseResult,
                index: parsers.indexOf(parser),
              });
            }
            if (parser.node.key && !parser.node.skip) {
              const reshaped = parseResult.result;
              result[parser.node.key] = reshaped;
            }
            // step cursor
            cursor += parseResult.len;
          }
          // const reshaped = reshape(result);
          return createParseSuccess(
            result,
            pos,
            cursor - pos,
            undefined,
            rule.reshape
          );
        } else {
          // string mode
          let ranges: (Range | string)[] = [];
          for (const parser of parsers) {
            const parseResult = parser.parse(ctx, cursor);
            if (parseResult.error) {
              if (parser.node.optional) continue;
              return createParseError(rule, cursor, rootId, {
                errorType: ERROR_Seq_Stop,
                childError: parseResult,
                index: parsers.indexOf(parser),
              });
            }
            if (!parser.node.skip) {
              if (parseResult.reshaped) {
                ranges.push(parseResult.result);
              } else {
                ranges.push(...parseResult.ranges);
              }
            }
            cursor += parseResult.len;
          }
          const text = buildRangesToString(ctx.raw, ranges);
          return createParseSuccess(
            text,
            pos,
            cursor - pos,
            ranges,
            rule.reshape
          );
        }
      };
    }
    default: {
      console.error(rule, rule === Object);
      throw new Error();
    }
  }
}
