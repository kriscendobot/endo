// @ts-check
// Establish a perimeter:
import '@endo/init/debug.js';

import test from 'ava';
import crypto from 'crypto';
import { decodeBase64 } from '@endo/base64';
import { makeCryptoPowers } from '../src/daemon-node-powers.js';
import {
  makeSqlPowersFromD1,
  makeSqlFilePowers,
  makeBlobPowersFromR2,
  makeCloudflareCryptoPowers,
  makeCloudflareDaemonicPersistencePowers,
  makeCloudflarePetStorePowers,
  makeCloudflareDaemonicPowers,
} from '../src/daemon-cloudflare-powers.js';
import {
  makeMockD1Database,
  makeMockR2Bucket,
} from './cloudflare-mock-bindings.js';
import { assertPetName } from '../src/pet-name.js';
import { formatId } from '../src/formula-identifier.js';

/** @import { FormulaNumber, NodeNumber, PetName } from '../src/types.js' */

/** @param {string} name */
const asPetName = name =>
  /** @type {PetName} */ (/** @type {unknown} */ (name));

// The daemon requires a synchronous incremental SHA-512 digester. On
// Workers that is @noble/hashes; in these node-side tests, node's crypto
// through the daemon's own node powers.
const { makeSha512 } = makeCryptoPowers(crypto);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const makeTestPowers = () => {
  const d1 = makeMockD1Database();
  const bucket = makeMockR2Bucket();
  const sqlPowers = makeSqlPowersFromD1(d1);
  const blobPowers = makeBlobPowersFromR2(bucket);
  const powers = makeCloudflareDaemonicPowers({
    sqlPowers,
    blobPowers,
    makeSha512,
  });
  return { d1, bucket, sqlPowers, blobPowers, powers };
};

const cryptoPowers = makeCloudflareCryptoPowers({ makeSha512 });

/** @returns {Promise<FormulaNumber>} */
const makeFormulaNumber = () =>
  /** @type {Promise<FormulaNumber>} */ (cryptoPowers.randomHex512());

const makeFormulaIdentifier = async () => {
  const number = await makeFormulaNumber();
  const node = /** @type {NodeNumber} */ (await cryptoPowers.randomHex512());
  return formatId({ number, node });
};

test('crypto powers produce well-formed randomness and digests', async t => {
  const a = await cryptoPowers.randomHex512();
  const b = await cryptoPowers.randomHex512();
  t.regex(a, /^[0-9a-f]{128}$/);
  t.not(a, b);

  const digester = cryptoPowers.makeSha512();
  digester.updateText('hello');
  const expected = crypto.createHash('sha512').update('hello').digest('hex');
  t.is(digester.digestHex(), expected);
});

test('root nonce is created once and persists across powers instances', async t => {
  const { sqlPowers, blobPowers, powers } = makeTestPowers();
  const { persistence } = powers;
  await persistence.initializePersistence();

  const first = await persistence.provideRootNonce();
  t.true(first.isNewlyCreated);
  t.regex(first.rootNonce, /^[0-9a-f]{128}$/);

  const second = await persistence.provideRootNonce();
  t.false(second.isNewlyCreated);
  t.is(second.rootNonce, first.rootNonce);

  // A fresh powers object over the same database (a daemon restart, or a
  // Durable Object waking from eviction) sees the same nonce.
  const revived = makeCloudflareDaemonicPersistencePowers({
    sqlPowers,
    blobPowers,
    cryptoPowers,
  });
  const third = await revived.provideRootNonce();
  t.false(third.isNewlyCreated);
  t.is(third.rootNonce, first.rootNonce);
});

test('formulas round-trip, upsert, and fail loudly when absent', async t => {
  const { powers } = makeTestPowers();
  const { persistence } = powers;
  await persistence.initializePersistence();

  const number = await makeFormulaNumber();
  const formula = { type: /** @type {const} */ ('worker') };
  await persistence.writeFormula(number, formula);
  t.deepEqual(await persistence.readFormula(number), formula);

  // The daemon re-preformulates well-known formulas at every boot; the
  // write must be an upsert.
  const replacement = { type: /** @type {const} */ ('least-authority') };
  await persistence.writeFormula(number, replacement);
  t.deepEqual(await persistence.readFormula(number), replacement);

  const missing = await makeFormulaNumber();
  await t.throwsAsync(() => persistence.readFormula(missing), {
    instanceOf: ReferenceError,
  });
});

test('sql file powers give filesystem semantics over the files table', async t => {
  const { sqlPowers } = makeTestPowers();
  await sqlPowers.init();
  const filePowers = makeSqlFilePowers(sqlPowers);

  const path = filePowers.joinPath('state', 'pet-store', 'aa', 'bb', 'alice');
  t.is(path, 'state/pet-store/aa/bb/alice');

  t.is(await filePowers.maybeReadFileText(path), undefined);
  await t.throwsAsync(() => filePowers.readFileText(path), {
    message: /^ENOENT: /,
  });

  await filePowers.writeFileText(path, 'content-1\n');
  t.is(await filePowers.readFileText(path), 'content-1\n');
  await filePowers.writeFileText(path, 'content-2\n');
  t.is(await filePowers.readFileText(path), 'content-2\n');

  await filePowers.writeFileText('state/pet-store/aa/bb/bob', 'b\n');
  await filePowers.writeFileText('state/pet-store/aa/cc/carol', 'c\n');
  t.deepEqual(
    [...(await filePowers.readDirectory('state/pet-store/aa/bb'))].sort(),
    ['alice', 'bob'],
  );
  // One level only: the directory listing names immediate children.
  t.deepEqual(
    [...(await filePowers.readDirectory('state/pet-store/aa'))].sort(),
    ['bb', 'cc'],
  );

  // Rename atomically replaces an existing target, like fs.rename.
  await filePowers.renamePath(path, 'state/pet-store/aa/bb/bob');
  t.is(
    await filePowers.readFileText('state/pet-store/aa/bb/bob'),
    'content-2\n',
  );
  t.is(await filePowers.maybeReadFileText(path), undefined);

  await t.throwsAsync(() => filePowers.renamePath(path, 'anywhere'), {
    message: /^ENOENT: /,
  });

  await filePowers.removePath('state/pet-store/aa/bb/bob');
  await t.throwsAsync(() => filePowers.removePath('state/pet-store/aa/bb/bob'), {
    message: /^ENOENT: /,
  });
});

test('pet stores persist names and reload from storage', async t => {
  const { sqlPowers, powers } = makeTestPowers();
  await powers.persistence.initializePersistence();

  const storeNumber = await makeFormulaNumber();
  const aliceId = await makeFormulaIdentifier();
  const carolId = await makeFormulaIdentifier();

  const petStore = await powers.petStore.makeIdentifiedPetStore(
    storeNumber,
    'pet-store',
    assertPetName,
  );

  await petStore.write(asPetName('alice'), aliceId);
  await petStore.write(asPetName('ally'), aliceId);
  await petStore.write(asPetName('carol'), carolId);
  t.true(petStore.has(asPetName('alice')));
  t.is(petStore.identifyLocal(asPetName('alice')), aliceId);
  t.deepEqual(
    [...petStore.list()],
    ['alice', 'ally', 'carol'].map(asPetName),
  );
  t.deepEqual(
    [...petStore.reverseIdentify(aliceId)].sort(),
    ['alice', 'ally'].map(asPetName),
  );

  // Rename over an existing name atomically rebinds it.
  await petStore.rename(asPetName('alice'), asPetName('carol'));
  t.is(petStore.identifyLocal(asPetName('carol')), aliceId);
  t.false(petStore.has(asPetName('alice')));
  t.deepEqual([...petStore.list()], ['ally', 'carol'].map(asPetName));

  await petStore.remove(asPetName('ally'));
  t.deepEqual([...petStore.list()], ['carol'].map(asPetName));

  // A fresh pet store over the same database rebuilds its in-memory table
  // from the persisted records, as on a daemon restart.
  const revivedPowers = makeCloudflarePetStorePowers({ sqlPowers });
  const revived = await revivedPowers.makeIdentifiedPetStore(
    storeNumber,
    'pet-store',
    assertPetName,
  );
  t.deepEqual([...revived.list()], ['carol'].map(asPetName));
  t.is(revived.identifyLocal(asPetName('carol')), aliceId);
});

test('content store is content-addressed, idempotent, and streams back', async t => {
  const { bucket, powers } = makeTestPowers();
  await powers.persistence.initializePersistence();
  const contentStore = powers.persistence.makeContentSha512Store();

  const content = `{"hello":"world","n":${'9'.repeat(64)}}`;
  const bytes = textEncoder.encode(content);
  const expectedSha512 = crypto
    .createHash('sha512')
    .update(bytes)
    .digest('hex');

  /** @returns {AsyncGenerator<Uint8Array, undefined, undefined>} */
  async function* chunked() {
    yield bytes.slice(0, 7);
    yield bytes.slice(7);
    return undefined;
  }

  const sha512 = await contentStore.store(chunked());
  t.is(sha512, expectedSha512);

  // Storing identical content again lands on the same key: dedup for free.
  const again = await contentStore.store(chunked());
  t.is(again, sha512);
  t.deepEqual(bucket.keys(), [`store-sha512/${sha512}`]);

  const readable = contentStore.fetch(sha512);
  t.is(readable.sha512(), sha512);
  t.is(await readable.text(), content);
  t.deepEqual(await readable.json(), JSON.parse(content));

  // streamBase64 frames the bytes as base64 chunks over the reader ref.
  // The far ref is near in this test, so its methods are directly callable.
  const reader = /** @type {import('@endo/stream').Reader<string>} */ (
    /** @type {unknown} */ (readable.streamBase64())
  );
  const collected = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.next(undefined);
    if (done) {
      break;
    }
    collected.push(decodeBase64(value));
  }
  const total = collected.reduce((n, chunk) => n + chunk.length, 0);
  const roundTripped = new Uint8Array(total);
  let index = 0;
  for (const chunk of collected) {
    roundTripped.set(chunk, index);
    index += chunk.length;
  }
  t.is(textDecoder.decode(roundTripped), content);

  const missing = contentStore.fetch('0'.repeat(128));
  await t.throwsAsync(() => missing.text(), { instanceOf: ReferenceError });
});

test('control powers are an explanatory stub pending the runtime design', async t => {
  const { powers } = makeTestPowers();
  const { promise: cancelled } = /** @type {{ promise: Promise<never> }} */ (
    /** @type {unknown} */ ({ promise: new Promise(() => {}) })
  );
  await t.throwsAsync(
    () => powers.control.makeWorker('w1', {}, cancelled),
    { message: /not yet supported on the Cloudflare platform/ },
  );
});
