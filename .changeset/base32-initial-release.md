---
'@endo/base32': major
---

Add `@endo/base32`, a hardened codec for lowercase, unpadded RFC 4648 base32.
The decoder accepts ASCII letter case while rejecting padding, separators,
impossible lengths, and non-zero trailing bits.
