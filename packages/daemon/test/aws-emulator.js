// @ts-check
// In-memory emulations of the narrow AWS client powers consumed by
// `daemon-aws-powers.js`, with the semantics the design relies on:
// conditional put, atomic transact, paginated query, and atomic blob
// visibility (a blob appears only when its stream completes). The tests
// prove the storage interface against these; the same tests run against
// real DynamoDB and S3 through `daemon-aws-sdk.js` (design phase 2).

import harden from '@endo/harden';

/** @import { DynamoTablePowers, S3BlobPowers } from '../src/daemon-aws-powers.js' */

/**
 * @param {object} [opts]
 * @param {number} [opts.pageSize] - Query page size, small by default so
 * tests exercise cursor pagination.
 * @returns {DynamoTablePowers & { snapshot: () => Map<string, string> }}
 */
export const makeTableEmulator = ({ pageSize = 2 } = {}) => {
  /** @type {Map<string, Map<string, string>>} */
  const partitions = new Map();

  /** @param {string} pk */
  const providePartition = pk => {
    let partition = partitions.get(pk);
    if (partition === undefined) {
      partition = new Map();
      partitions.set(pk, partition);
    }
    return partition;
  };

  /** @type {DynamoTablePowers['put']} */
  const put = async ({ pk, sk, value, ifAbsent = false }) => {
    const partition = providePartition(pk);
    if (ifAbsent && partition.has(sk)) {
      return { applied: false };
    }
    partition.set(sk, value);
    return { applied: true };
  };

  /** @type {DynamoTablePowers['get']} */
  const get = async ({ pk, sk }) => {
    return partitions.get(pk)?.get(sk);
  };

  /** @type {DynamoTablePowers['delete']} */
  const deleteItem = async ({ pk, sk }) => {
    partitions.get(pk)?.delete(sk);
  };

  /** @type {DynamoTablePowers['query']} */
  const query = async ({ pk, cursor }) => {
    const partition = partitions.get(pk);
    const keys = partition === undefined ? [] : [...partition.keys()].sort();
    const start = cursor === undefined ? 0 : keys.indexOf(cursor) + 1;
    const page = keys.slice(start, start + pageSize);
    const items = page.map(sk => ({
      sk,
      value: /** @type {string} */ (
        /** @type {Map<string, string>} */ (partition).get(sk)
      ),
    }));
    const last = start + pageSize;
    return {
      items,
      ...(last < keys.length ? { cursor: page[page.length - 1] } : {}),
    };
  };

  /** @type {DynamoTablePowers['transact']} */
  const transact = async ({ deletes, puts }) => {
    // Apply atomically: nothing here can fail partway, so a simple
    // sequential apply preserves all-or-nothing.
    for (const { pk, sk } of deletes) {
      partitions.get(pk)?.delete(sk);
    }
    for (const { pk, sk, value } of puts) {
      providePartition(pk).set(sk, value);
    }
  };

  const snapshot = () => {
    /** @type {Map<string, string>} */
    const flat = new Map();
    for (const [pk, partition] of partitions.entries()) {
      for (const [sk, value] of partition.entries()) {
        flat.set(`${pk}|${sk}`, value);
      }
    }
    return flat;
  };

  return harden({
    put,
    get,
    delete: deleteItem,
    query,
    transact,
    snapshot,
  });
};

/**
 * @param {object} [opts]
 * @param {number} [opts.chunkSize] - Read chunk size, small by default so
 * tests exercise multi-chunk streaming.
 * @returns {S3BlobPowers & { keys: () => Array<string> }}
 */
export const makeBlobEmulator = ({ chunkSize = 4 } = {}) => {
  /** @type {Map<string, Uint8Array>} */
  const blobs = new Map();

  /** @type {S3BlobPowers['putBlobStream']} */
  const putBlobStream = async ({ key, readable }) => {
    const chunks = [];
    let byteLength = 0;
    for await (const chunk of readable) {
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
    // The blob becomes visible only now, after the whole stream has been
    // consumed, matching S3's atomic put visibility.
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    blobs.set(key, bytes);
  };

  /** @type {S3BlobPowers['hasBlob']} */
  const hasBlob = async ({ key }) => {
    return blobs.has(key);
  };

  /** @type {S3BlobPowers['getBlobStream']} */
  const getBlobStream = async ({ key }) => {
    const bytes = blobs.get(key);
    if (bytes === undefined) {
      throw new Error(`NoSuchKey: ${key}`);
    }
    return (async function* streamBlob() {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, offset + chunkSize);
      }
    })();
  };

  /** @type {S3BlobPowers['copyBlob']} */
  const copyBlob = async ({ from, to }) => {
    const bytes = blobs.get(from);
    if (bytes === undefined) {
      throw new Error(`NoSuchKey: ${from}`);
    }
    blobs.set(to, bytes);
  };

  /** @type {S3BlobPowers['deleteBlob']} */
  const deleteBlob = async ({ key }) => {
    blobs.delete(key);
  };

  const keys = () => harden([...blobs.keys()].sort());

  return harden({
    putBlobStream,
    hasBlob,
    getBlobStream,
    copyBlob,
    deleteBlob,
    keys,
  });
};
