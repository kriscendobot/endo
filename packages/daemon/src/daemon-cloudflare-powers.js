// @ts-check
/* global globalThis */

// Cloudflare storage platform for the Endo daemon.
// Design: docs/cloudflare-storage.md.
//
// This module provides the daemon's storage powers (crypto, pet stores,
// persistence) over two narrow injected capability seams:
//
//   SqlPowers  — a SQLite-flavored store, adapted from either a D1 database
//                binding or a Durable Object's SQLite storage. Formulas, the
//                root nonce, and the pet-name records live here.
//   BlobPowers — a content blob store, adapted from an R2 bucket binding.
//                The content-addressed sha512 store lives here.
//
// No Cloudflare API is touched outside the adapters, and no account
// identifier or credential appears anywhere: bindings are injected
// capabilities, per the daemon's powers discipline.

import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { q } from '@endo/errors';
import { makeReaderRef } from './reader-ref.js';
import { makePetStoreMaker } from './pet-store.js';

/** @import { Reader, Writer } from '@endo/stream' */
/** @import { Config, CryptoPowers, DaemonicPersistencePowers, DaemonicControlPowers, DaemonicPowers, EndoReadable, FilePowers, Formula, FormulaNumber, PetStorePowers, Sha512 } from './types.js' */

/**
 * A SQLite-flavored storage seam. Both adapters guarantee:
 * - `run` executes a single statement atomically.
 * - `batch` executes all statements in one transaction (all or nothing).
 *
 * @typedef {object} SqlPowers
 * @property {() => Promise<void>} init - Create the schema idempotently.
 * @property {(sql: string, params?: Array<string>) => Promise<Record<string, unknown> | undefined>} get
 * @property {(sql: string, params?: Array<string>) => Promise<Array<Record<string, unknown>>>} all
 * @property {(sql: string, params?: Array<string>) => Promise<{ changes: number }>} run
 * @property {(statements: Array<{ sql: string, params?: Array<string> }>) => Promise<Array<{ changes: number }>>} batch
 */

/**
 * A content blob storage seam over an object store.
 *
 * @typedef {object} BlobBody
 * @property {() => AsyncIterable<Uint8Array>} stream
 * @property {() => Promise<string>} text
 *
 * @typedef {object} BlobPowers
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 * @property {(key: string) => Promise<BlobBody | undefined>} get
 * @property {(key: string) => Promise<boolean>} has
 * @property {(key: string) => Promise<void>} delete
 */

// #region Cloudflare binding surface types
// Minimal structural types for the Cloudflare bindings this module accepts,
// so the package does not take a dependency on @cloudflare/workers-types.
// They describe only the subset of the binding APIs the adapters use.

/**
 * @typedef {object} D1PreparedStatement
 * @property {(...params: Array<unknown>) => D1PreparedStatement} bind
 * @property {() => Promise<Record<string, unknown> | null>} first
 * @property {() => Promise<{ results: Array<Record<string, unknown>> }>} all
 * @property {() => Promise<{ meta: { changes: number } }>} run
 *
 * @typedef {object} D1Database
 * @property {(sql: string) => D1PreparedStatement} prepare
 * @property {(statements: Array<D1PreparedStatement>) => Promise<Array<{ meta: { changes: number } }>>} batch
 *
 * @typedef {object} SqlStorageCursor
 * @property {() => Array<Record<string, unknown>>} toArray
 * @property {number} [rowsWritten]
 *
 * @typedef {object} SqlStorage
 * @property {(sql: string, ...params: Array<unknown>) => SqlStorageCursor} exec
 *
 * @typedef {object} DurableObjectStorage
 * @property {SqlStorage} sql
 * @property {<T>(callback: () => T) => T} transactionSync
 *
 * @typedef {object} R2ObjectBody
 * @property {ReadableStream<Uint8Array>} body
 * @property {() => Promise<string>} text
 *
 * @typedef {object} R2Bucket
 * @property {(key: string, value: Uint8Array | ReadableStream<Uint8Array>) => Promise<unknown>} put
 * @property {(key: string, options?: { range?: { offset: number, length?: number } }) => Promise<R2ObjectBody | null>} get
 * @property {(key: string) => Promise<unknown | null>} head
 * @property {(key: string) => Promise<void>} delete
 */

// #endregion

const schemaStatements = [
  // One-value table for the root nonce (and future singletons).
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Formula records, keyed by 128-hex formula number.
  `CREATE TABLE IF NOT EXISTS formulas (
    number  TEXT PRIMARY KEY,
    formula TEXT NOT NULL
  )`,
  // Small-text-file emulation backing makeSqlFilePowers, used by the
  // unmodified pet-store.js.
  `CREATE TABLE IF NOT EXISTS files (
    path    TEXT PRIMARY KEY,
    content TEXT NOT NULL
  )`,
];

/**
 * Adapts a Cloudflare D1 database binding to the SqlPowers seam.
 * D1 executes a batch of prepared statements as one implicit transaction.
 *
 * @param {D1Database} d1
 * @returns {SqlPowers}
 */
export const makeSqlPowersFromD1 = d1 => {
  /**
   * @param {string} sql
   * @param {Array<string>} [params]
   */
  const prepare = (sql, params = []) => d1.prepare(sql).bind(...params);

  return harden({
    init: async () => {
      // No synchronous preamble.
      await null;

      for (const statement of schemaStatements) {
        // eslint-disable-next-line no-await-in-loop
        await prepare(statement).run();
      }
    },
    get: async (sql, params) => {
      const row = await prepare(sql, params).first();
      return row === null ? undefined : row;
    },
    all: async (sql, params) => {
      const { results } = await prepare(sql, params).all();
      return results;
    },
    run: async (sql, params) => {
      const { meta } = await prepare(sql, params).run();
      return { changes: meta.changes };
    },
    batch: async statements => {
      const results = await d1.batch(
        statements.map(({ sql, params }) => prepare(sql, params)),
      );
      return results.map(({ meta }) => ({ changes: meta.changes }));
    },
  });
};

/**
 * Adapts a Durable Object's SQLite-backed storage to the SqlPowers seam.
 * The DO storage API is synchronous; `transactionSync` provides multi-
 * statement atomicity for `batch`.
 *
 * @param {DurableObjectStorage} storage
 * @returns {SqlPowers}
 */
export const makeSqlPowersFromDurableObjectStorage = storage => {
  const { sql } = storage;

  /**
   * @param {string} statement
   * @param {Array<string>} [params]
   */
  const exec = (statement, params = []) => sql.exec(statement, ...params);

  return harden({
    init: async () => {
      for (const statement of schemaStatements) {
        exec(statement);
      }
    },
    get: async (statement, params) => {
      const rows = exec(statement, params).toArray();
      return rows.length > 0 ? rows[0] : undefined;
    },
    all: async (statement, params) => exec(statement, params).toArray(),
    run: async (statement, params) => {
      const cursor = exec(statement, params);
      cursor.toArray();
      return { changes: cursor.rowsWritten ?? 0 };
    },
    batch: async statements =>
      storage.transactionSync(() =>
        statements.map(({ sql: statement, params }) => {
          const cursor = exec(statement, params);
          cursor.toArray();
          return { changes: cursor.rowsWritten ?? 0 };
        }),
      ),
  });
};

/**
 * Iterates a Web ReadableStream as Uint8Array chunks, tolerating hosts where
 * ReadableStream is not itself async-iterable.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncIterable<Uint8Array>}
 */
const iterateBody = async function* iterateBody(body) {
  // No synchronous preamble.
  await null;

  const asyncIterable = /** @type {AsyncIterable<Uint8Array>} */ (
    /** @type {unknown} */ (body)
  );
  if (Symbol.asyncIterator in asyncIterable) {
    yield* asyncIterable;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
};

/**
 * Adapts a Cloudflare R2 bucket binding to the BlobPowers seam.
 *
 * @param {R2Bucket} bucket
 * @returns {BlobPowers}
 */
export const makeBlobPowersFromR2 = bucket =>
  harden({
    put: async (key, bytes) => {
      await bucket.put(key, bytes);
    },
    get: async key => {
      const object = await bucket.get(key);
      if (object === null) {
        return undefined;
      }
      return harden({
        stream: () => iterateBody(object.body),
        text: () => object.text(),
      });
    },
    has: async key => {
      const head = await bucket.head(key);
      return head !== null;
    },
    delete: async key => {
      await bucket.delete(key);
    },
  });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * A FilePowers implementation over the SqlPowers `files` table, sufficient
 * for the daemon's small-text-record stores (pet stores). This is what lets
 * the unmodified pet-store.js run on Cloudflare. Every mutation is a single
 * atomic statement (or an atomic batch, for rename-over-existing), which is
 * stronger than the multi-step filesystem equivalents.
 *
 * Streaming reads and writes are buffered emulations for interface
 * completeness only: content blobs belong in BlobPowers, not in SQL rows.
 *
 * @param {SqlPowers} sqlPowers
 * @returns {FilePowers}
 */
export const makeSqlFilePowers = sqlPowers => {
  /** @param {string} path */
  const readFileText = async path => {
    const row = await sqlPowers.get(
      `SELECT content FROM files WHERE path = ?`,
      [path],
    );
    if (row === undefined) {
      // Message shape matters: callers distinguish absence by the ENOENT
      // prefix, as with node's filesystem errors.
      throw Error(`ENOENT: no such file, read ${q(path)}`);
    }
    return /** @type {string} */ (row.content);
  };

  /** @param {string} path */
  const maybeReadFileText = async path => {
    const row = await sqlPowers.get(
      `SELECT content FROM files WHERE path = ?`,
      [path],
    );
    return row === undefined ? undefined : /** @type {string} */ (row.content);
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const writeFileText = async (path, text) => {
    await sqlPowers.run(
      `INSERT INTO files (path, content) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET content = excluded.content`,
      [path, text],
    );
  };

  /** @param {string} path */
  const readDirectory = async path => {
    const prefix = `${path}/`;
    const rows = await sqlPowers.all(
      `SELECT path FROM files WHERE path LIKE ? ESCAPE '\\'`,
      [`${prefix.replace(/[%_\\]/g, '\\$&')}%`],
    );
    const names = new Set();
    for (const row of rows) {
      const rest = /** @type {string} */ (row.path).slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return harden([...names]);
  };

  /** @param {string} _path */
  const makePath = async _path => {
    // Directories are implicit in the path-keyed table.
  };

  /** @param {string} path */
  const removePath = async path => {
    const { changes } = await sqlPowers.run(
      `DELETE FROM files WHERE path = ?`,
      [path],
    );
    if (changes === 0) {
      throw Error(`ENOENT: no such file, rm ${q(path)}`);
    }
  };

  /**
   * @param {string} source
   * @param {string} target
   */
  const renamePath = async (source, target) => {
    // Like fs.rename: atomically replaces any existing target.
    const results = await sqlPowers.batch([
      { sql: `DELETE FROM files WHERE path = ?`, params: [target] },
      {
        sql: `UPDATE files SET path = ? WHERE path = ?`,
        params: [target, source],
      },
    ]);
    if (results[1].changes === 0) {
      throw Error(`ENOENT: no such file, rename ${q(source)}`);
    }
  };

  /**
   * @param {...string} components
   */
  const joinPath = (...components) => components.join('/');

  /**
   * @param {string} path
   * @returns {Reader<Uint8Array>}
   */
  const makeFileReader = path => {
    /** @returns {AsyncGenerator<Uint8Array, undefined, undefined>} */
    async function* generate() {
      const text = await readFileText(path);
      yield textEncoder.encode(text);
      return undefined;
    }
    return generate();
  };

  /**
   * @param {string} path
   * @returns {Writer<Uint8Array>}
   */
  const makeFileWriter = path => {
    /** @type {Array<Uint8Array>} */
    const chunks = [];
    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      async next(chunk) {
        chunks.push(chunk);
        return harden({ done: false, value: undefined });
      },
      async return(_value) {
        let length = 0;
        for (const chunk of chunks) {
          length += chunk.length;
        }
        const bytes = new Uint8Array(length);
        let index = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, index);
          index += chunk.length;
        }
        await writeFileText(path, textDecoder.decode(bytes));
        return harden({ done: true, value: undefined });
      },
      async throw(_error) {
        return harden({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return writer;
  };

  return harden({
    makeFileReader,
    makeFileWriter,
    writeFileText,
    readFileText,
    maybeReadFileText,
    readDirectory,
    makePath,
    joinPath,
    removePath,
    renamePath,
  });
};

/**
 * The daemon requires a synchronous incremental SHA-512 digester
 * (formula-number derivation and content hashing both use it), which
 * WebCrypto's one-shot async `subtle.digest` cannot provide, so the digester
 * factory is injected: `@noble/hashes/sha512` on Workers, node's crypto in
 * node-side tests. Randomness comes from the host's WebCrypto
 * `getRandomValues`, present on Workers and modern node alike.
 *
 * @param {object} args
 * @param {() => Sha512} args.makeSha512
 * @returns {CryptoPowers}
 */
export const makeCloudflareCryptoPowers = ({ makeSha512 }) => {
  const randomHex512 = async () => {
    const bytes = new Uint8Array(64);
    globalThis.crypto.getRandomValues(bytes);
    return encodeHex(bytes);
  };
  return harden({
    makeSha512,
    randomHex512,
  });
};

/**
 * @param {object} args
 * @param {SqlPowers} args.sqlPowers
 * @param {BlobPowers} args.blobPowers
 * @param {CryptoPowers} args.cryptoPowers
 * @param {string} [args.blobPrefix]
 * @returns {DaemonicPersistencePowers}
 */
export const makeCloudflareDaemonicPersistencePowers = ({
  sqlPowers,
  blobPowers,
  cryptoPowers,
  blobPrefix = 'store-sha512/',
}) => {
  const initializePersistence = async () => {
    await sqlPowers.init();
  };

  /** @type {DaemonicPersistencePowers['provideRootNonce']} */
  const provideRootNonce = async () => {
    const candidate = await cryptoPowers.randomHex512();
    // A single atomic conditional insert decides the winner; the node
    // implementation's read-then-write relied on process discipline instead.
    const { changes } = await sqlPowers.run(
      `INSERT INTO meta (key, value) VALUES ('rootNonce', ?)
       ON CONFLICT(key) DO NOTHING`,
      [candidate],
    );
    const isNewlyCreated = changes > 0;
    const row = await sqlPowers.get(
      `SELECT value FROM meta WHERE key = 'rootNonce'`,
    );
    if (row === undefined) {
      throw Error('Root nonce vanished between write and read');
    }
    const rootNonce = /** @type {FormulaNumber} */ (row.value);
    return harden({ rootNonce, isNewlyCreated });
  };

  const makeContentSha512Store = () => {
    /** @param {string} sha512 */
    const keyFor = sha512 => `${blobPrefix}${sha512}`;

    return harden({
      /**
       * @param {AsyncIterable<Uint8Array>} readable
       * @returns {Promise<string>}
       */
      async store(readable) {
        const digester = cryptoPowers.makeSha512();
        /** @type {Array<Uint8Array>} */
        const chunks = [];
        let length = 0;
        for await (const chunk of readable) {
          digester.update(chunk);
          chunks.push(chunk);
          length += chunk.length;
        }
        // Toy scaffold: the buffered small-object path only. The multipart
        // spool-and-restream path for objects beyond the Worker memory
        // budget is design § 4.3, build phase 2.
        const bytes = new Uint8Array(length);
        let index = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, index);
          index += chunk.length;
        }
        const sha512 = digester.digestHex();
        // Content-addressed: concurrent writers of the same content write
        // identical bytes to the same key, so the race is benign, and a
        // completed put is visible all-or-nothing.
        await blobPowers.put(keyFor(sha512), bytes);
        return sha512;
      },
      /**
       * @param {string} sha512
       * @returns {EndoReadable}
       */
      fetch(sha512) {
        const key = keyFor(sha512);
        const provideBlob = async () => {
          const blob = await blobPowers.get(key);
          if (blob === undefined) {
            throw ReferenceError(`No content exists for hash ${q(sha512)}`);
          }
          return blob;
        };
        const streamBase64 = () => {
          /** @returns {AsyncGenerator<Uint8Array, undefined, undefined>} */
          async function* generate() {
            const blob = await provideBlob();
            yield* blob.stream();
            return undefined;
          }
          return makeReaderRef(generate());
        };
        const text = async () => {
          const blob = await provideBlob();
          return blob.text();
        };
        const json = async () => {
          const jsonSrc = await text();
          return JSON.parse(jsonSrc);
        };
        return harden({
          sha512: () => sha512,
          streamBase64,
          text,
          json,
        });
      },
    });
  };

  /** @type {DaemonicPersistencePowers['readFormula']} */
  const readFormula = async formulaNumber => {
    const row = await sqlPowers.get(
      `SELECT formula FROM formulas WHERE number = ?`,
      [formulaNumber],
    );
    if (row === undefined) {
      throw ReferenceError(
        `No formula exists for number ${q(formulaNumber)}`,
      );
    }
    try {
      return JSON.parse(/** @type {string} */ (row.formula));
    } catch (error) {
      throw TypeError(
        `Corrupt formula for number ${q(formulaNumber)}: ${
          /** @type {Error} */ (error).message
        }`,
      );
    }
  };

  /** @type {DaemonicPersistencePowers['writeFormula']} */
  const writeFormula = async (formulaNumber, formula) => {
    // A single upsert statement: atomic, resolving the node
    // implementation's outstanding TODO on atomic formula writes.
    await sqlPowers.run(
      `INSERT INTO formulas (number, formula) VALUES (?, ?)
       ON CONFLICT(number) DO UPDATE SET formula = excluded.formula`,
      [formulaNumber, JSON.stringify(formula)],
    );
  };

  return harden({
    initializePersistence,
    provideRootNonce,
    makeContentSha512Store,
    readFormula,
    writeFormula,
  });
};

/**
 * Pet stores ride the unmodified daemon-core pet-store module over the SQL
 * file powers; the Config paths degenerate to logical key prefixes in the
 * `files` table.
 *
 * @param {object} args
 * @param {SqlPowers} args.sqlPowers
 * @param {string} [args.statePrefix]
 * @returns {PetStorePowers}
 */
export const makeCloudflarePetStorePowers = ({
  sqlPowers,
  statePrefix = 'state',
}) => {
  const filePowers = makeSqlFilePowers(sqlPowers);
  /** @type {Config} */
  const config = {
    statePath: statePrefix,
    ephemeralStatePath: `${statePrefix}-ephemeral`,
    cachePath: `${statePrefix}-cache`,
    sockPath: '',
  };
  return makePetStoreMaker(filePowers, config);
};

/**
 * Endo workers require an execution design (isolate-per-worker Durable
 * Objects or dynamically dispatched Workers), not a storage design; see
 * docs/cloudflare-storage.md § 6.
 *
 * @returns {DaemonicControlPowers}
 */
export const makeStubControlPowers = () =>
  harden({
    makeWorker: async workerId => {
      throw Error(
        `Endo workers are not yet supported on the Cloudflare platform (worker ${q(
          workerId,
        )}); see @endo/daemon docs/cloudflare-storage.md`,
      );
    },
  });

/**
 * Assembles the daemon's powers from injected Cloudflare bindings (already
 * adapted to the seams). Control powers default to the explanatory stub
 * until the Workers execution design lands.
 *
 * @param {object} args
 * @param {SqlPowers} args.sqlPowers
 * @param {BlobPowers} args.blobPowers
 * @param {() => Sha512} args.makeSha512
 * @param {string} [args.statePrefix]
 * @param {string} [args.blobPrefix]
 * @param {DaemonicControlPowers} [args.controlPowers]
 * @returns {DaemonicPowers}
 */
export const makeCloudflareDaemonicPowers = ({
  sqlPowers,
  blobPowers,
  makeSha512,
  statePrefix,
  blobPrefix,
  controlPowers = makeStubControlPowers(),
}) => {
  const cryptoPowers = makeCloudflareCryptoPowers({ makeSha512 });
  const petStorePowers = makeCloudflarePetStorePowers({
    sqlPowers,
    statePrefix,
  });
  const daemonicPersistencePowers = makeCloudflareDaemonicPersistencePowers({
    sqlPowers,
    blobPowers,
    cryptoPowers,
    blobPrefix,
  });
  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: controlPowers,
  });
};
