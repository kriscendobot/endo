// @ts-check
// Proves the AWS storage platform (`src/daemon-aws-powers.js`) against the
// daemon's storage interface, using the in-memory client-power emulations
// in `aws-emulator.js`. See `docs/aws-storage.md` § Test plan.

import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'crypto';

import { decodeBase64 } from '@endo/base64';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { makeCryptoPowers } from '../src/daemon-node-powers.js';
import {
  makeAwsDaemonicPersistencePowers,
  makeAwsPetStoreMaker,
} from '../src/daemon-aws-powers.js';
import { assertPetName } from '../src/pet-name.js';
import { formatId } from '../src/formula-identifier.js';
import { makeTableEmulator, makeBlobEmulator } from './aws-emulator.js';

/** @import { FormulaNumber, NodeNumber } from '../src/types.js' */

const cryptoPowers = makeCryptoPowers(crypto);

const textEncoder = new TextEncoder();

const makePowers = () => {
  const table = makeTableEmulator();
  const blobs = makeBlobEmulator();
  const persistence = makeAwsDaemonicPersistencePowers(
    table,
    blobs,
    cryptoPowers,
  );
  const petStorePowers = makeAwsPetStoreMaker(table);
  return { table, blobs, persistence, petStorePowers };
};

/** @param {string} digit */
const formulaNumber = digit =>
  /** @type {FormulaNumber} */ (digit.repeat(128));

/** @param {string} digit */
const identifier = digit =>
  formatId({
    number: formulaNumber(digit),
    node: /** @type {NodeNumber} */ ('0'.repeat(128)),
  });

/** @param {any} readerRef - A far async iterator of base64 chunks. */
const collectBase64Reader = async readerRef => {
  // No synchronous preamble.
  await null;

  const chunks = [];
  const iterator =
    Symbol.asyncIterator in readerRef
      ? readerRef[Symbol.asyncIterator]()
      : readerRef;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await iterator.next(undefined);
    if (result.done) {
      break;
    }
    chunks.push(decodeBase64(result.value));
  }
  let byteLength = 0;
  for (const chunk of chunks) {
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

test('provideRootNonce creates once and is stable thereafter', async t => {
  const { persistence } = makePowers();
  const first = await persistence.provideRootNonce();
  t.true(first.isNewlyCreated);
  t.regex(first.rootNonce, /^[0-9a-f]{128}$/);
  const second = await persistence.provideRootNonce();
  t.false(second.isNewlyCreated);
  t.is(second.rootNonce, first.rootNonce);
});

test('provideRootNonce race converges on a single winner', async t => {
  const { persistence } = makePowers();
  const results = await Promise.all([
    persistence.provideRootNonce(),
    persistence.provideRootNonce(),
    persistence.provideRootNonce(),
  ]);
  const nonces = new Set(results.map(({ rootNonce }) => rootNonce));
  t.is(nonces.size, 1);
  t.is(results.filter(({ isNewlyCreated }) => isNewlyCreated).length, 1);
});

test('formulas round-trip and absence is a ReferenceError', async t => {
  const { persistence } = makePowers();
  const number = formulaNumber('a');
  const formula = { type: 'eval', worker: identifier('b'), source: '1 + 1' };
  // @ts-expect-error the formula literal stands in for the full union type.
  await persistence.writeFormula(number, formula);
  const read = await persistence.readFormula(number);
  t.deepEqual(read, formula);
  await t.throwsAsync(() => persistence.readFormula(formulaNumber('c')), {
    instanceOf: ReferenceError,
    message: /No reference exists/,
  });
});

test('content store round-trips text, json, and base64 streams', async t => {
  const { persistence } = makePowers();
  const contentStore = persistence.makeContentSha512Store();
  const content = JSON.stringify({ hello: 'aws' });
  const contentBytes = bytesFromText(content);
  const expectedSha512 = crypto
    .createHash('sha512')
    .update(contentBytes)
    .digest('hex');

  async function* readable() {
    // Deliberately many small chunks, to exercise streaming.
    for (let offset = 0; offset < contentBytes.byteLength; offset += 3) {
      yield contentBytes.subarray(offset, offset + 3);
    }
  }
  const sha512 = await contentStore.store(readable());
  t.is(sha512, expectedSha512);

  const readableBlob = contentStore.fetch(sha512);
  t.is(readableBlob.sha512(), sha512);
  t.is(await readableBlob.text(), content);
  t.deepEqual(await readableBlob.json(), { hello: 'aws' });
  const streamedBytes = await collectBase64Reader(readableBlob.streamBase64());
  t.deepEqual(streamedBytes, contentBytes);
});

test('content store deduplicates and leaves no staging keys', async t => {
  const { persistence, blobs } = makePowers();
  const contentStore = persistence.makeContentSha512Store();
  const contentBytes = textEncoder.encode('same content twice');

  async function* readable() {
    yield contentBytes;
  }
  const first = await contentStore.store(readable());
  const second = await contentStore.store(readable());
  t.is(first, second);
  t.deepEqual(blobs.keys(), [`store-sha512/${first}`]);
});

test('pet store writes, lists, identifies, removes, renames', async t => {
  const { petStorePowers } = makePowers();
  const petStore = await petStorePowers.makeIdentifiedPetStore(
    formulaNumber('d'),
    'pet-store',
    assertPetName,
  );

  await petStore.write(/** @type {any} */ ('alice'), identifier('1'));
  await petStore.write(/** @type {any} */ ('bob'), identifier('2'));
  t.true(petStore.has(/** @type {any} */ ('alice')));
  t.is(petStore.identifyLocal(/** @type {any} */ ('alice')), identifier('1'));
  t.deepEqual(petStore.list(), ['alice', 'bob']);
  t.deepEqual(petStore.reverseIdentify(identifier('1')), ['alice']);

  // Rename atomically, overwriting an existing target name.
  await petStore.rename(
    /** @type {any} */ ('alice'),
    /** @type {any} */ ('bob'),
  );
  t.deepEqual(petStore.list(), ['bob']);
  t.is(petStore.identifyLocal(/** @type {any} */ ('bob')), identifier('1'));
  t.deepEqual(petStore.reverseIdentify(identifier('2')), []);

  await petStore.remove(/** @type {any} */ ('bob'));
  t.deepEqual(petStore.list(), []);
  await t.throwsAsync(() => petStore.remove(/** @type {any} */ ('bob')), {
    message: /Formula does not exist for pet name/,
  });
});

test('pet store reloads its names from the table, across pages', async t => {
  const { table, petStorePowers } = makePowers();
  const petStore = await petStorePowers.makeIdentifiedPetStore(
    formulaNumber('e'),
    'pet-store',
    assertPetName,
  );
  const names = ['apple', 'banana', 'cherry', 'damson', 'elderberry'];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    await petStore.write(/** @type {any} */ (name), identifier('3'));
  }

  // A second pet store over the same table partition rebuilds the same
  // name graph; with the emulator's page size of 2, this exercises
  // query-cursor pagination.
  const petStorePowersReloaded = makeAwsPetStoreMaker(table);
  const reloaded = await petStorePowersReloaded.makeIdentifiedPetStore(
    formulaNumber('e'),
    'pet-store',
    assertPetName,
  );
  t.deepEqual(reloaded.list(), names);
  t.is(reloaded.identifyLocal(/** @type {any} */ ('cherry')), identifier('3'));
});

test('pet store follows name changes, current then subsequent', async t => {
  const { petStorePowers } = makePowers();
  const petStore = await petStorePowers.makeIdentifiedPetStore(
    formulaNumber('f'),
    'pet-store',
    assertPetName,
  );
  await petStore.write(/** @type {any} */ ('existing'), identifier('4'));

  const changes = petStore.followNameChanges();
  const first = await changes.next();
  t.deepEqual(first.value, {
    add: 'existing',
    value: {
      id: identifier('4'),
      number: formulaNumber('4'),
      node: '0'.repeat(128),
    },
  });

  const nextChange = changes.next();
  await petStore.write(/** @type {any} */ ('later'), identifier('5'));
  const second = await nextChange;
  t.false(Boolean(second.done));
  const change = /** @type {any} */ (second.value);
  t.is(change.add, 'later');
});
