# `@endo/base32`

`@endo/base32` encodes and decodes `Uint8Array` values using the RFC 4648
base32 alphabet.
It emits lowercase text without padding, a form suitable for
case-insensitive identifiers such as DNS labels and capability designators.

## Install

```sh
npm install @endo/base32
```

## Usage

```js
import { encodeBase32 } from '@endo/base32/encode.js';
import { decodeBase32 } from '@endo/base32/decode.js';

const encoded = encodeBase32(new Uint8Array([102, 111, 111])); // 'mzxw6'
const decoded = decodeBase32(encoded); // Uint8Array(3) [102, 111, 111]
```

The package root also exports both functions:

```js
import { decodeBase32, encodeBase32 } from '@endo/base32';
```

## API

### `encodeBase32(bytes) -> string`

Encodes bytes as lowercase RFC 4648 base32 without `=` padding.

### `decodeBase32(string, name?) -> Uint8Array`

Decodes unpadded RFC 4648 base32.
ASCII letters are case-insensitive.
Padding, separators, invalid lengths, and non-zero trailing bits are rejected.
The optional `name` is included in error messages for diagnostic context.

Rejecting non-zero trailing bits prevents multiple strings from decoding to
the same bytes, apart from ASCII letter case.
Callers that require a lowercase canonical identifier can compare their input
with `encodeBase32(decodeBase32(input))`.

## Hardened JavaScript

The exported codec functions are hardened at module evaluation time.
The implementation does not retain or return mutable module-scoped lookup
tables.
