import test from '@endo/ses-ava/test.js';

import { decodeBase32, encodeBase32 } from '../index.js';

/** @type {Array<[number[], string]>} */
const vectors = [
  [[], ''],
  [[102], 'my'],
  [[102, 111], 'mzxq'],
  [[102, 111, 111], 'mzxw6'],
  [[102, 111, 111, 98], 'mzxw6yq'],
  [[102, 111, 111, 98, 97], 'mzxw6ytb'],
  [[102, 111, 111, 98, 97, 114], 'mzxw6ytboi'],
];

test('encodeBase32 matches the RFC 4648 test vectors', t => {
  for (const [byteValues, encoded] of vectors) {
    t.is(encodeBase32(Uint8Array.from(byteValues)), encoded);
  }
});

test('decodeBase32 matches the RFC 4648 test vectors', t => {
  for (const [byteValues, encoded] of vectors) {
    t.deepEqual(decodeBase32(encoded), Uint8Array.from(byteValues));
    t.deepEqual(
      decodeBase32(encoded.toUpperCase()),
      Uint8Array.from(byteValues),
    );
  }
});

test('round-trips byte sequences across quantum boundaries', t => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = Uint8Array.from(
      { length },
      (_unused, index) => (index * 37 + length * 19) % 256,
    );
    t.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
  }
});

test('round-trips the full byte space', t => {
  const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
  t.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
});

test('decodeBase32 rejects characters outside the ASCII alphabet', t => {
  for (const encoded of [
    'm=',
    'm-zxq',
    'm zxq',
    'm1',
    'm0',
    'm8',
    '\u212Amzxq',
  ]) {
    const error = t.throws(() => decodeBase32(encoded, 'designator'));
    t.regex(/** @type {Error} */ (error).message, /offset/);
    t.regex(/** @type {Error} */ (error).message, /designator/);
  }
});

test('decodeBase32 rejects impossible encoded lengths', t => {
  for (const encoded of ['a', 'aaa', 'aaaaaa']) {
    t.throws(() => decodeBase32(encoded), { message: /length/ });
  }
});

test('decodeBase32 rejects non-zero trailing bits', t => {
  for (const encoded of ['mz', 'mzxz', 'mzxw7', 'mzxw6yr', 'mzxw6ytboj']) {
    t.throws(() => decodeBase32(encoded), { message: /trailing bits/ });
  }
});

test('exports are hardened', t => {
  t.true(Object.isFrozen(encodeBase32));
  t.true(Object.isFrozen(decodeBase32));
});
