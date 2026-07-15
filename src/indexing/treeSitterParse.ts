import Parser = require('node-tree-sitter');

/**
 * node-tree-sitter's string-input parse path defaults to a 32KB internal read
 * buffer and throws "Invalid argument" for any input past that boundary
 * (confirmed via direct testing against real-world files well over 32KB in
 * both Python and TypeScript -- see docs/engineering-log/TREESITTER_BUFFER_BUG_REPORT.md). Every
 * parser.parse(content) call site needs an explicit bufferSize to avoid this;
 * this wrapper centralizes that fix so it isn't reintroduced ad hoc at future
 * call sites, and otherwise preserves the null-on-any-parse-failure contract
 * every call site already relied on.
 */
export function parseSourceSafely(parser: Parser, content: string): Parser.Tree | null {
    try {
        return parser.parse(content, undefined, { bufferSize: content.length + 1024 });
    } catch {
        return null;
    }
}
