export enum NodeTypes {
  AnyExpression = 1,
  Identifier,
  ParenExpression,
  LefthandSideExpression,
  CallExpression,
  MemberAccessExpression,
}
export const _ = "([\\s\\n]+)?";
export const __ = "\\s+";
export const PAIRED_CHARS = ["(", ")", "{", "}", "[", "]", "<", ">"] as const;

export const BinaryOperators = [
  // 3 chars
  "\\>\\>\\>",
  "\\=\\=\\=",
  "\\!\\=\\=",

  // 2 chars
  "\\|\\|",
  "\\&\\&",
  "\\*\\*",
  "\\>\\=",
  "\\<\\=",
  "\\=\\=",
  "\\!\\=",
  "\\<\\<",
  "\\>\\>",

  "\\+\\=",
  "\\-\\=",
  "\\*\\=",
  "\\|\\=",
  "\\/\\=",
  "\\?\\?",

  // 1 chars
  "\\+",
  "\\-",
  "\\|",
  "\\&",
  "\\*",
  "\\/",
  "\\>",
  "\\<",
  "\\^",
  "\\%",
  "\\=",
];

export const RESERVED_WORDS = [
  "break",
  "const",
  "let",
  "if",
  "while",
  "do",
  "else",
  "default",
  "case",
  "debugger",
  "continue",
  "instanceof",
  "import",
  "in",
  "new",
  "return",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "delete",
  "export",
  "from",
  "of",
  "yield",
  "await",
  "async",
  "function",
  "get",
  "set",
  "static",
  "class",
  "extends",
  "super",
  "const",
  "enum",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "implements",
  "with",
  "class",
  "super",
  "null",
  "true",
  "false",
];
