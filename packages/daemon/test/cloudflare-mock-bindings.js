// @ts-check

// In-memory stand-ins for the Cloudflare bindings that
// daemon-cloudflare-powers.js accepts, mirroring the binding API subsets the
// adapters use (see docs/cloudflare-storage.md § 9). The mock D1 database is
// backed by node's built-in SQLite (real SQL semantics, including
// batch-as-transaction); the mock R2 bucket is Map-backed with streaming
// bodies. The same test suite is designed to re-point at Miniflare/workerd,
// which emulate the real services locally, in the build phase.

// @ts-ignore This repository's @types/node predates the built-in sqlite
// module's type declarations.
import { DatabaseSync } from 'node:sqlite';

/** @import { D1Database, D1PreparedStatement, R2Bucket, R2ObjectBody } from '../src/daemon-cloudflare-powers.js' */

/**
 * @returns {D1Database}
 */
export const makeMockD1Database = () => {
  const db = new DatabaseSync(':memory:');

  /**
   * @param {string} sql
   * @param {Array<unknown>} params
   */
  const runSync = (sql, params) => {
    const { changes } = db
      .prepare(sql)
      .run(.../** @type {Array<string>} */ (params));
    return { meta: { changes: Number(changes) } };
  };

  /** @type {WeakMap<D1PreparedStatement, { sql: string, params: () => Array<unknown> }>} */
  const statementText = new WeakMap();

  /** @param {string} sql */
  const prepare = sql => {
    /** @type {Array<unknown>} */
    let boundParams = [];
    /** @type {D1PreparedStatement} */
    const statement = {
      bind: (...params) => {
        boundParams = params;
        return statement;
      },
      first: async () => {
        const row = db
          .prepare(sql)
          .get(.../** @type {Array<string>} */ (boundParams));
        return row === undefined
          ? null
          : /** @type {Record<string, unknown>} */ (row);
      },
      all: async () => ({
        results: /** @type {Array<Record<string, unknown>>} */ (
          db.prepare(sql).all(.../** @type {Array<string>} */ (boundParams))
        ),
      }),
      run: async () => runSync(sql, boundParams),
    };
    // Stash for batch() below, which replays statements inside one
    // transaction the way D1 executes a batch.
    statementText.set(statement, { sql, params: () => boundParams });
    return statement;
  };

  /** @type {D1Database['batch']} */
  const batch = async statements => {
    db.exec('BEGIN');
    try {
      const results = statements.map(statement => {
        const record = statementText.get(statement);
        if (record === undefined) {
          throw Error('Mock D1 batch received a foreign statement');
        }
        return runSync(record.sql, record.params());
      });
      db.exec('COMMIT');
      return results;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return { prepare, batch };
};

/**
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array>}
 */
const streamOfBytes = bytes =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const textDecoder = new TextDecoder();

/**
 * @returns {R2Bucket & { keys: () => Array<string> }}
 */
export const makeMockR2Bucket = () => {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map();

  /** @param {Uint8Array | ReadableStream<Uint8Array>} value */
  const collect = async value => {
    // No synchronous preamble.
    await null;

    if (value instanceof Uint8Array) {
      return value.slice();
    }
    /** @type {Array<Uint8Array>} */
    const chunks = [];
    let length = 0;
    const reader = value.getReader();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(chunk);
      length += chunk.length;
    }
    const bytes = new Uint8Array(length);
    let index = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, index);
      index += chunk.length;
    }
    return bytes;
  };

  return {
    put: async (key, value) => {
      const bytes = await collect(value);
      objects.set(key, bytes);
    },
    get: async key => {
      // No synchronous preamble.
      await null;

      const bytes = objects.get(key);
      if (bytes === undefined) {
        return null;
      }
      /** @type {R2ObjectBody} */
      const body = {
        body: streamOfBytes(bytes),
        text: async () => textDecoder.decode(bytes),
      };
      return body;
    },
    head: async key => (objects.has(key) ? { key } : null),
    delete: async key => {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
  };
};
