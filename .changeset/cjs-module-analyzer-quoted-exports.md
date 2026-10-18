---
'@endo/cjs-module-analyzer': minor
---

Synchronize quoted export-name handling with upstream `cjs-module-lexer` 2.2.0.
`analyzeCommonJS` now detects quoted export names in `exports['...']`, `Object.defineProperty(exports, '...', ...)`, and `module.exports = { '...': ... }` forms, including names that are not identifiers, such as `exports['a-b']`.
String-literal escapes in those names (`\u`, `\u{...}`, `\x`, octal, line continuations, and U+2028/U+2029) are decoded, so `exports['a']` reports `a`.
Reserved words are no longer filtered out, so `exports.package` and `exports.var` are now reported.
Consumers such as `@endo/compartment-mapper` may therefore see export names they did not see before.
