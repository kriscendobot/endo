/* global globalThis */

import {
  hiddenBuffers,
  reverseHiddenBuffers,
  FERAL_GET_ARRAY_BUFFER,
} from './immutable-arraybuffer-pony-internal.js';

const {
  Object,
  Reflect,
  WeakMap,
  TypeError,
  Uint8Array,
  Proxy,
  // eslint-disable-next-line no-restricted-globals
} = globalThis;

const {
  getOwnPropertyDescriptor,
  getOwnPropertyDescriptors,
  defineProperties,
  getPrototypeOf,
  setPrototypeOf,
} = Object;
const { apply, construct } = Reflect;
const { get: weakMapGet, has: weakMapHas } = WeakMap.prototype;
const TypedArray = getPrototypeOf(Uint8Array);

/**
 * Could be used by the shim as the getter for a replacement of
 * `TypedArray.prototype.buffer`.
 *
 * BUG TODO FIXME BROKEN the this-argument should be a real or emulated
 * TypedArray, not an ArrayBuffer.
 */
export const virtualTypedArrayBufferGetter = (() => {
  /** @type {ThisType<ArrayBuffer>} */
  const obj = {
    get buffer() {
      if (apply(weakMapHas, reverseHiddenBuffers, [this])) {
        return apply(weakMapGet, reverseHiddenBuffers, [this]);
      } else {
        return apply(FERAL_GET_ARRAY_BUFFER, this, []);
      }
    },
  };
  const { get: pseudoGetter } = /** @type {PropertyDescriptor} */ (
    getOwnPropertyDescriptor(obj, 'buffer')
  );
  return pseudoGetter;
})();

/**
 * Could be used by the shim to replace all the concrete TypedArray constructors
 * with constructors that also accept an emulated immutable ArrayBuffer
 * argument.
 *
 * @param {any} OriginalConstructor
 */
export const makePseudoTypedArrayConstructor = OriginalConstructor => {
  /**
   * @param {any[]} args
   */
  function PseudoTypedArray(...args) {
    if (new.target === undefined) {
      throw new TypeError(
        `Constructor ${OriginalConstructor.name} requires 'new'`,
      );
    }
    const firstArg = args[0];
    if (apply(weakMapHas, hiddenBuffers, [firstArg])) {
      if (args.length !== 1) {
        throw new TypeError(`only one ArrayBuffer argument expected`);
      }
      if (new.target !== PseudoTypedArray) {
        throw new TypeError(
          'emulated freezable TypedArray does not (yet?) support subclassing.',
        );
      }
      const hiddenBuffer = apply(weakMapGet, hiddenBuffers, [firstArg]);
      const hiddenTypedArray = construct(
        OriginalConstructor,
        [hiddenBuffer],
        PseudoTypedArray,
      );
      const proxy = new Proxy(hiddenTypedArray, {
        // TODO trap and error on all attempts to mutate an indexed property.
        // Non-indexed properties as well as queries should pass through to
        // the target.
      });
      return proxy;
    } else {
      return construct(OriginalConstructor, args, new.target);
    }
  }
  defineProperties(
    PseudoTypedArray,
    getOwnPropertyDescriptors(OriginalConstructor),
  );
  setPrototypeOf(PseudoTypedArray, TypedArray);
};
