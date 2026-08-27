// @ts-check

import harden from '@endo/harden';

/**
 * Returns the base32 digit for an ASCII code point, or -1 if it is not in the
 * RFC 4648 alphabet.
 *
 * @param {number} codePoint
 * @returns {number}
 */
const digitForCodePoint = codePoint => {
  // ASCII A-Z and a-z are equivalent for decoding.
  if (codePoint >= 65 && codePoint <= 90) {
    return codePoint - 65;
  }
  if (codePoint >= 97 && codePoint <= 122) {
    return codePoint - 97;
  }
  if (codePoint >= 50 && codePoint <= 55) {
    return codePoint - 24;
  }
  return -1;
};

/**
 * Decodes padded-free RFC 4648 base32 into bytes.
 *
 * Accepts uppercase and lowercase ASCII letters. Rejects padding, separators,
 * impossible encoded lengths, and non-zero trailing bits so that every byte
 * sequence has exactly one encoding apart from ASCII letter case.
 *
 * @param {string} string Base32-encoded string.
 * @param {string} [name] Name of the string for error diagnostics.
 * @returns {Uint8Array}
 */
export const decodeBase32 = (string, name = '<unknown>') => {
  const bytes = new Uint8Array(Math.floor((string.length * 5) / 8));
  let accumulator = 0;
  let bitCount = 0;
  let byteIndex = 0;

  for (
    let characterIndex = 0;
    characterIndex < string.length;
    characterIndex += 1
  ) {
    const digit = digitForCodePoint(string.charCodeAt(characterIndex));
    if (digit < 0) {
      throw Error(
        `Invalid base32 character at offset ${characterIndex} of string ${name}`,
      );
    }

    accumulator = accumulator * 32 + digit;
    bitCount += 5;

    if (bitCount >= 8) {
      const divisor = 2 ** (bitCount - 8);
      const byte = Math.floor(accumulator / divisor);
      bytes[byteIndex] = byte;
      byteIndex += 1;
      accumulator -= byte * divisor;
      bitCount -= 8;
    }
  }

  if (bitCount >= 5) {
    throw Error(`Invalid base32 length ${string.length} in string ${name}`);
  }
  if (accumulator !== 0) {
    throw Error(`Non-zero base32 trailing bits in string ${name}`);
  }

  return bytes;
};
harden(decodeBase32);
