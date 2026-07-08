// @ts-check
// The AWS storage platform for the Endo daemon: DynamoDB carries the
// structured, mutable state (root nonce, formulas, pet-name graphs) and S3
// carries the content-addressed blob store, behind the same
// `DaemonicPersistencePowers` and `PetStorePowers` interfaces the node
// platform implements over the filesystem in `daemon-node-powers.js`.
// Design: `docs/aws-storage.md`.
//
// The factories here receive narrow, pre-authorized client powers
// (`DynamoTablePowers`, `S3BlobPowers`) rather than SDK clients, so this
// module carries no AWS dependency and no ambient authority; the SDK
// adapters live in `daemon-aws-sdk.js`.

import harden from '@endo/harden';
import { q } from '@endo/errors';
import { bytesToText } from '@endo/bytes/to-string.js';
import { makeReaderRef } from './reader-ref.js';
import { makeChangeTopic } from './pubsub.js';
import { parseId, assertValidId, isValidNumber } from './formula-identifier.js';
import { makeBidirectionalMultimap } from './multimap.js';
import { makeDaemonicControlPowers } from './daemon-node-powers.js';

/** @import { BidirectionalMultimap, Config, CryptoPowers, DaemonicPersistencePowers, DaemonicPowers, EndoReadable, FilePowers, Formula, FormulaNumber, IdChangesTopic, Name, NameChangesTopic, PetStore, PetStoreIdNameChange, PetStorePowers } from './types.js' */

/**
 * A capability bound to one DynamoDB table (or a faithful emulation).
 * Values are strings; keys are `{ pk, sk }` string pairs. `get` and `query`
 * are strongly consistent. `transact` applies all of its writes atomically
 * or none of them.
 *
 * @typedef {object} DynamoTablePowers
 * @property {(args: {
 *   pk: string,
 *   sk: string,
 *   value: string,
 *   ifAbsent?: boolean,
 * }) => Promise<{ applied: boolean }>} put
 * @property {(args: { pk: string, sk: string }) => Promise<string | undefined>} get
 * @property {(args: { pk: string, sk: string }) => Promise<void>} delete
 * @property {(args: { pk: string, cursor?: string }) => Promise<{
 *   items: Array<{ sk: string, value: string }>,
 *   cursor?: string,
 * }>} query
 * @property {(args: {
 *   deletes: Array<{ pk: string, sk: string }>,
 *   puts: Array<{ pk: string, sk: string, value: string }>,
 * }) => Promise<void>} transact
 */

/**
 * A capability bound to one S3 bucket and key prefix (or a faithful
 * emulation). A blob put or copied becomes visible atomically: a reader
 * never observes a partial blob.
 *
 * @typedef {object} S3BlobPowers
 * @property {(args: {
 *   key: string,
 *   readable: AsyncIterable<Uint8Array>,
 * }) => Promise<void>} putBlobStream
 * @property {(args: { key: string }) => Promise<boolean>} hasBlob
 * @property {(args: { key: string }) => Promise<AsyncIterable<Uint8Array>>} getBlobStream
 * @property {(args: { from: string, to: string }) => Promise<void>} copyBlob
 * @property {(args: { key: string }) => Promise<void>} deleteBlob
 */

const rootNonceKey = harden({ pk: 'config', sk: 'rootNonce' });

/**
 * @param {string} formulaNumber
 */
const formulaKey = formulaNumber => {
  if (formulaNumber.length < 3) {
    throw new TypeError(`Invalid formula number ${q(formulaNumber)}`);
  }
  return harden({ pk: `formula:${formulaNumber}`, sk: 'formula' });
};

/**
 * @param {DynamoTablePowers} tablePowers
 * @param {S3BlobPowers} blobPowers
 * @param {CryptoPowers} cryptoPowers
 * @returns {DaemonicPersistencePowers}
 */
export const makeAwsDaemonicPersistencePowers = (
  tablePowers,
  blobPowers,
  cryptoPowers,
) => {
  const initializePersistence = async () => {
    // The table and bucket are provisioned out of band (see
    // docs/aws-storage.md § Provisioning); nothing to create here. A probe
    // read surfaces missing resources or authority at startup rather than
    // on first use.
    await tablePowers.get(rootNonceKey);
  };

  /** @type {DaemonicPersistencePowers['provideRootNonce']} */
  const provideRootNonce = async () => {
    const candidate = await cryptoPowers.randomHex512();
    const { applied } = await tablePowers.put({
      ...rootNonceKey,
      value: candidate,
      ifAbsent: true,
    });
    if (applied) {
      return {
        rootNonce: /** @type {FormulaNumber} */ (candidate),
        isNewlyCreated: true,
      };
    }
    const existingNonce = await tablePowers.get(rootNonceKey);
    if (existingNonce === undefined) {
      throw new Error(
        'Root nonce disappeared between conditional write and read',
      );
    }
    return {
      rootNonce: /** @type {FormulaNumber} */ (existingNonce),
      isNewlyCreated: false,
    };
  };

  const makeContentSha512Store = () => {
    return harden({
      /**
       * @param {AsyncIterable<Uint8Array>} readable
       * @returns {Promise<string>}
       */
      async store(readable) {
        // No synchronous preamble.
        await null;

        const digester = cryptoPowers.makeSha512();
        const stagingKey = `staging/${await cryptoPowers.randomHex512()}`;

        // The content hash (the final key) is unknown until the stream
        // ends, so stream to a staging key while digesting, then copy to
        // the content-addressed key, mirroring the node platform's
        // temporary-file-then-rename dance.
        async function* digestingStream() {
          for await (const chunk of readable) {
            digester.update(chunk);
            yield chunk;
          }
        }
        await blobPowers.putBlobStream({
          key: stagingKey,
          readable: digestingStream(),
        });

        const sha512 = digester.digestHex();
        const contentKey = `store-sha512/${sha512}`;
        if (!(await blobPowers.hasBlob({ key: contentKey }))) {
          await blobPowers.copyBlob({ from: stagingKey, to: contentKey });
        }
        await blobPowers.deleteBlob({ key: stagingKey });
        return sha512;
      },
      /**
       * @param {string} sha512
       * @returns {EndoReadable}
       */
      fetch(sha512) {
        const contentKey = `store-sha512/${sha512}`;
        async function* streamContent() {
          // No synchronous preamble.
          await null;
          yield* await blobPowers.getBlobStream({ key: contentKey });
        }
        const streamBase64 = () => makeReaderRef(streamContent());
        const text = async () => {
          // No synchronous preamble.
          await null;

          const chunks = [];
          let byteLength = 0;
          for await (const chunk of streamContent()) {
            chunks.push(chunk);
            byteLength += chunk.byteLength;
          }
          const bytes = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytesToText(bytes);
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

  /**
   * @param {string} formulaNumber
   * @returns {Promise<Formula>}
   */
  const readFormula = async formulaNumber => {
    const key = formulaKey(formulaNumber);
    const formulaText = await tablePowers.get(key);
    if (formulaText === undefined) {
      throw new ReferenceError(
        `No reference exists for formula number ${q(formulaNumber)}`,
      );
    }
    try {
      return JSON.parse(formulaText);
    } catch (error) {
      throw new TypeError(
        `Corrupt description for reference for formula number ${q(formulaNumber)}: ${/** @type {Error} */ (error).message}`,
      );
    }
  };

  /** @type {DaemonicPersistencePowers['writeFormula']} */
  const writeFormula = async (formulaNumber, formula) => {
    const key = formulaKey(formulaNumber);
    // A DynamoDB put is atomic per item, so unlike the node platform's
    // file write, a torn formula record cannot be observed.
    await tablePowers.put({ ...key, value: JSON.stringify(formula) });
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
 * @param {DynamoTablePowers} tablePowers
 * @returns {PetStorePowers}
 */
export const makeAwsPetStoreMaker = tablePowers => {
  /**
   * @param {string} partition
   * @param {(name: string) => asserts name is Name} assertValidName
   * @returns {Promise<PetStore>}
   */
  const makePetStoreAtPartition = async (partition, assertValidName) => {
    /** @type {BidirectionalMultimap<string, Name>} */
    const idsToPetNames = makeBidirectionalMultimap();
    /** @type {NameChangesTopic} */
    const nameChangesTopic = makeChangeTopic();

    /** @returns {IdChangesTopic} */
    const makeIdChangeTopic = () => makeChangeTopic();
    /** @type {Map<string, ReturnType<typeof makeIdChangeTopic>>} */
    const idsToTopics = new Map();

    /** @param {Name} petName */
    const nameSortKey = petName => `name:${petName}`;

    /**
     * Publishes an id change to its subscribers, if any.
     *
     * @param {string} id - The id to publish a change for.
     * @param {PetStoreIdNameChange} payload - The payload to publish.
     */
    const publishIdChangeToSubscribers = (id, payload) => {
      const idTopic = idsToTopics.get(id);
      if (idTopic !== undefined) {
        idTopic.publisher.next(payload);
      }
    };

    /**
     * @param {string} id - The id receiving a new name.
     * @param {Name} petName - The new name.
     */
    const publishNameAddition = (id, petName) => {
      const idRecord = parseId(id);
      nameChangesTopic.publisher.next({
        add: petName,
        value: idRecord,
      });
      publishIdChangeToSubscribers(id, {
        add: idRecord,
        names: [petName],
      });
    };

    /**
     * @param {string} id - The id from which a name is being removed.
     * @param {Name} petName - The removed name.
     */
    const publishNameRemoval = (id, petName) => {
      nameChangesTopic.publisher.next({
        remove: petName,
      });
      if (id !== undefined) {
        publishIdChangeToSubscribers(id, {
          remove: parseId(id),
          names: [petName],
        });
      }
    };

    // Load the whole name graph into memory, as the node platform does by
    // listing the pet-name directory; every read is served from memory and
    // the table sees only mutations.
    // No synchronous preamble.
    await null;

    /** @type {string | undefined} */
    let cursor;
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await tablePowers.query({ pk: partition, cursor });
      for (const { sk, value } of page.items) {
        const petName = sk.slice('name:'.length);
        assertValidName(petName);
        assertValidId(value, petName);
        idsToPetNames.add(value, petName);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);

    /** @type {PetStore['has']} */
    const has = petName => {
      assertValidName(petName);
      return idsToPetNames.hasValue(petName);
    };

    /** @type {PetStore['identifyLocal']} */
    const identifyLocal = petName => {
      assertValidName(petName);
      return idsToPetNames.getKey(petName);
    };

    /** @type {PetStore['write']} */
    const write = async (petName, formulaIdentifier) => {
      assertValidName(petName);
      assertValidId(formulaIdentifier);

      if (idsToPetNames.hasValue(petName)) {
        const oldFormulaIdentifier = idsToPetNames.getKey(petName);
        if (oldFormulaIdentifier === formulaIdentifier) {
          return;
        }

        if (oldFormulaIdentifier !== undefined) {
          // Perform cleanup on the overwritten pet name.
          idsToPetNames.delete(oldFormulaIdentifier, petName);
          publishNameRemoval(oldFormulaIdentifier, petName);
        }
      }

      idsToPetNames.add(formulaIdentifier, petName);

      await tablePowers.put({
        pk: partition,
        sk: nameSortKey(petName),
        value: formulaIdentifier,
      });
      publishNameAddition(formulaIdentifier, petName);
    };

    /** @type {PetStore['list']} */
    const list = () => harden(idsToPetNames.getAll().sort());

    /** @type {PetStore['followNameChanges']} */
    const followNameChanges = async function* currentAndSubsequentNames() {
      const subscription = nameChangesTopic.subscribe();
      for (const name of idsToPetNames.getAll().sort()) {
        const idRecord = parseId(
          /** @type {string} */ (idsToPetNames.getKey(name)),
        );

        yield {
          add: name,
          value: idRecord,
        };
      }
      yield* subscription;
    };

    /** @type {PetStore['followIdNameChanges']} */
    const followIdNameChanges = async function* currentAndSubsequentIds(id) {
      if (!idsToTopics.has(id)) {
        idsToTopics.set(id, makeIdChangeTopic());
      }
      const idTopic = /** @type {IdChangesTopic} */ (idsToTopics.get(id));
      const subscription = idTopic.subscribe();

      const existingNames = idsToPetNames.getAllFor(id).sort();
      yield {
        add: parseId(id),
        names: existingNames,
      };

      yield* subscription;
    };

    /** @type {PetStore['remove']} */
    const remove = async petName => {
      assertValidName(petName);
      const formulaIdentifier = idsToPetNames.getKey(petName);
      if (formulaIdentifier === undefined) {
        throw new Error(
          `Formula does not exist for pet name ${JSON.stringify(petName)}`,
        );
      }
      assertValidId(formulaIdentifier, petName);

      await tablePowers.delete({ pk: partition, sk: nameSortKey(petName) });
      idsToPetNames.delete(formulaIdentifier, petName);
      publishNameRemoval(formulaIdentifier, petName);
    };

    /** @type {PetStore['rename']} */
    const rename = async (fromName, toName) => {
      assertValidName(fromName);
      assertValidName(toName);
      if (fromName === toName) {
        return;
      }
      const formulaIdentifier = idsToPetNames.getKey(fromName);
      const overwrittenId = idsToPetNames.getKey(toName);
      if (formulaIdentifier === undefined) {
        throw new Error(
          `Formula does not exist for pet name ${JSON.stringify(fromName)}`,
        );
      }
      assertValidId(formulaIdentifier, fromName);

      // The atomic delete-plus-put preserves the atomic-replace semantics
      // the node platform gets from fs.rename: no observer, and no crash,
      // can see the graph with both names or neither.
      await tablePowers.transact({
        deletes: [{ pk: partition, sk: nameSortKey(fromName) }],
        puts: [
          {
            pk: partition,
            sk: nameSortKey(toName),
            value: formulaIdentifier,
          },
        ],
      });

      // Delete the back-reference for the overwritten pet name if it existed.
      if (overwrittenId !== undefined) {
        idsToPetNames.delete(overwrittenId, toName);
        publishNameRemoval(overwrittenId, toName);
      }

      // Update the mapping for the pet name.
      idsToPetNames.delete(formulaIdentifier, fromName);
      idsToPetNames.add(formulaIdentifier, toName);

      publishNameRemoval(formulaIdentifier, fromName);
      publishNameAddition(formulaIdentifier, toName);
    };

    /** @type {PetStore['reverseIdentify']} */
    const reverseIdentify = formulaIdentifier => {
      assertValidId(formulaIdentifier);
      const formulaPetNames = idsToPetNames.getAllFor(formulaIdentifier);
      if (formulaPetNames === undefined) {
        return harden([]);
      }
      return harden([...formulaPetNames]);
    };

    const petStore = {
      has,
      identifyLocal,
      reverseIdentify,
      list,
      followIdNameChanges,
      followNameChanges,
      write,
      remove,
      rename,
    };

    return petStore;
  };

  /**
   * @type {PetStorePowers['makeIdentifiedPetStore']}
   */
  const makeIdentifiedPetStore = (
    formulaNumber,
    formulaType,
    assertValidName,
  ) => {
    if (!isValidNumber(formulaNumber)) {
      throw new Error(
        `Invalid formula number for pet store ${q(formulaNumber)}`,
      );
    }
    const partition = `petStore:${formulaType}:${formulaNumber}`;
    return makePetStoreAtPartition(partition, assertValidName);
  };

  return {
    makeIdentifiedPetStore,
  };
};

/**
 * Composes the AWS storage powers with the node platform's control powers:
 * durable state lives in AWS, while workers, logs, and sockets stay on the
 * local machine. Parallel to `makeDaemonicPowers` in
 * `daemon-node-powers.js`.
 *
 * @param {object} opts
 * @param {Config} opts.config
 * @param {typeof import('fs')} opts.fs
 * @param {typeof import('child_process')} opts.popen
 * @param {typeof import('url')} opts.url
 * @param {FilePowers} opts.filePowers
 * @param {CryptoPowers} opts.cryptoPowers
 * @param {DynamoTablePowers} opts.tablePowers
 * @param {S3BlobPowers} opts.blobPowers
 * @returns {DaemonicPowers}
 */
export const makeDaemonicAwsPowers = ({
  config,
  fs,
  popen,
  url,
  filePowers,
  cryptoPowers,
  tablePowers,
  blobPowers,
}) => {
  const { fileURLToPath } = url;

  const petStorePowers = makeAwsPetStoreMaker(tablePowers);
  const daemonicPersistencePowers = makeAwsDaemonicPersistencePowers(
    tablePowers,
    blobPowers,
    cryptoPowers,
  );
  const daemonicControlPowers = makeDaemonicControlPowers(
    config,
    fileURLToPath,
    filePowers,
    fs,
    popen,
  );

  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: daemonicControlPowers,
  });
};
