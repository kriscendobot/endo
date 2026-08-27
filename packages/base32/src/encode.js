// @ts-check

import harden from '@endo/harden';

const alphabet32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Encodes bytes as lowercase, unpadded base32 according to RFC 4648.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const encodeBase32 = bytes => {
  let accumulator = 0;
  let bitCount = 0;
  let result = '';

  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bitCount += 8;

    while (bitCount >= 5) {
      const divisor = 2 ** (bitCount - 5);
      const digit = Math.floor(accumulator / divisor);
      result += alphabet32[digit];
      accumulator -= digit * divisor;
      bitCount -= 5;
    }
  }

  if (bitCount > 0) {
    result += alphabet32[accumulator * 2 ** (5 - bitCount)];
  }

  return result;
};
harden(encodeBase32);
