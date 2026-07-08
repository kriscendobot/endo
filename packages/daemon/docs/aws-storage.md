# Design: an AWS storage platform for the Endo daemon

| | |
| --- | --- |
| Status | draft |
| Author | Kriscendo Bot (garden designer) |
| Date | 2026-07-08 |
| Sibling | a CloudFlare storage platform is designed in parallel; both implement the same daemon storage seam |

## Problem

The Endo daemon persists all durable state through a small set of injected
powers. Today the only durable-storage platform is Node's filesystem
(`daemon-node-powers.js`). This design adds an **AWS platform**: the daemon
still runs on Node (workers, sockets, and crypto stay platform-native), but
its durable state lives in **DynamoDB** (structured, mutable state) and
**S3** (content-addressed immutable blobs). The daemon core (`daemon.js`)
is untouched; the AWS platform is a new implementation behind the existing
powers interface.

Note for readers arriving with the folk model "node = filesystem + sqlite":
as of `endojs/endo` master (f859ca067, 2026-05), there is **no sqlite** in
`@endo/daemon`. The node platform is filesystem-only. The seam this design
implements is the powers interface described next, not a database API.

## The storage seam (what must be implemented)

`DaemonicPowers` (`src/types.d.ts`) has four members. Two carry durable
state, and those two are the entire surface of this design:

### `DaemonicPersistencePowers`

- `initializePersistence()` — one-time setup (node: `mkdir -p`; AWS:
  verify or create the table and bucket, see § Provisioning).
- `provideRootNonce() -> { rootNonce, isNewlyCreated }` — read-or-create a
  single 128-hex root secret.
- `makeContentSha512Store() -> { store, fetch }` — the content-addressed
  blob store:
  - `store(readable: AsyncIterable<Uint8Array>) -> Promise<sha512hex>`
    streams content of unknown length, hashing as it goes; only complete,
    hash-named content may become visible.
  - `fetch(sha512) -> EndoReadable` is **synchronous and lazy**; the
    returned `{ sha512(), streamBase64(), text(), json() }` touches storage
    only when consumed. `streamBase64()` wraps a `Uint8Array` reader with
    `makeReaderRef` (`reader-ref.js`), the ocap stream handed over CapTP.
- `readFormula(formulaNumber) -> Promise<Formula>` — throws
  `ReferenceError` ("No reference exists ...") when absent.
- `writeFormula(formulaNumber, formula)` — persist a small JSON record.
  Formula numbers are 128 hex chars; formulas are small (well under 4KB).

### `PetStorePowers`

`makeIdentifiedPetStore(formulaNumber, formulaType, assertValidName) ->
Promise<PetStore>` where `formulaType` is one of `pet-store`,
`known-peers-store`, `mailbox-store`. A `PetStore` (see `pet-store.js`) is
a name graph: `write`, `remove`, `rename`, `has`, `identifyLocal`,
`reverseIdentify`, `list`, `followNameChanges`, `followIdNameChanges`.
The node implementation loads the whole store into an in-memory
bidirectional multimap at creation and serves every read from memory;
storage sees only the mutations (`write`, `remove`, `rename`).

### Consistency baseline the daemon already provides

Two facts of `daemon.js` bound what the storage layer must guarantee:

1. All formula-graph mutations are serialized in-process through
   `makeSerialJobs` (`formulaGraphJobs` in `daemon.js`), and formulas are
   memoized in `formulaForId` after first read.
2. The pet store's in-memory multimap is the read path; persistent storage
   is write-mostly and read only at store creation.

So the platform needs **per-operation atomicity and read-after-write
consistency within a single daemon process**, not cross-operation
transactions. One operation, `rename`, mutates two keys and must be atomic
(node uses `fs.rename`, which atomically replaces the target).

## Platform shape

Parallel to the node platform's module pair, plus an SDK adapter:

- `src/daemon-aws-powers.js` — the platform factories:
  `makeAwsDaemonicPersistencePowers`, `makeAwsPetStoreMaker`, and
  `makeDaemonicAwsPowers` (which composes them with the node control,
  crypto, and file powers). Written against two **narrow injected client
  powers** (below); imports no AWS SDK.
- `src/daemon-aws-sdk.js` — adapters that produce those client powers from
  AWS SDK v3 clients. The SDK **module namespaces are parameters** (the
  caller passes the result of `import('@aws-sdk/client-dynamodb')` and
  friends), so `@endo/daemon` takes no dependency on the SDK.
- `src/daemon-aws.js` — the main entry, mirroring `daemon-node.js`: reads
  AWS config from the environment, dynamically imports the SDK, assembles
  powers, calls `makeDaemon`.

```mermaid
graph LR
  subgraph daemon core (untouched)
    D[daemon.js makeDaemon]
  end
  subgraph AWS platform
    P[daemon-aws-powers.js]
    A[daemon-aws-sdk.js]
  end
  D -- DaemonicPersistencePowers, PetStorePowers --> P
  P -- DynamoTablePowers --> A
  P -- S3BlobPowers --> A
  A --> DDB[(DynamoDB table)]
  A --> S3[(S3 bucket)]
  D -- control, crypto, network powers --> N[daemon-node-powers.js]
```

### The injected client powers (credentials as powers)

There is **no ambient AWS authority** anywhere in the platform. The
factories receive two capability records; whoever constructs them (the
main entry, a test, a deployment harness) decides region, credentials,
table, and bucket. The powers are *semantic operations*, not SDK command
pass-throughs, so the trusted path contains no expression-string grammar
and both the SDK adapter and the test emulator stay small:

```js
// DynamoTablePowers — one DynamoDB table, keys are { pk, sk } strings.
{
  put({ pk, sk, value, ifAbsent }),   // ifAbsent: conditional create;
                                      // resolves { applied: boolean }
  get({ pk, sk }),                    // consistent read; -> value | undefined
  delete({ pk, sk }),
  query({ pk, cursor }),              // -> { items: [{ sk, value }], cursor? }
  transact({ deletes: [{pk, sk}], puts: [{pk, sk, value}] }),  // atomic
}

// S3BlobPowers — one bucket (plus optional key prefix).
{
  putBlobStream({ key, readable }),   // streaming/multipart put
  hasBlob({ key }),
  getBlobStream({ key }),             // -> AsyncIterable<Uint8Array>
  copyBlob({ from, to }),             // server-side copy
  deleteBlob({ key }),
}
```

The config record injected alongside is
`{ region, tableName, bucketName, keyPrefix }` for the entry point's use;
the powers themselves are already bound to table and bucket, so the
factories only ever see capabilities. The package is account-agnostic; a
reference deployment may use the garden's AWS account, but nothing in the
code names an account, and the IAM policy needed is exactly the operation
list above scoped to one table and one bucket.

## DynamoDB design (in place of the structured filesystem state)

One table, on-demand capacity, key schema `pk` (HASH, string) + `sk`
(RANGE, string). Single-table because the daemon's structured state is a
handful of small record kinds, transactions must span the pet-name pairs,
and one table is one config value.

| Kind | pk | sk | value |
| --- | --- | --- | --- |
| Root nonce | `config` | `rootNonce` | 128-hex nonce |
| Formula | `formula:<formulaNumber>` | `formula` | formula JSON text |
| Pet name | `petStore:<formulaType>:<formulaNumber>` | `name:<petName>` | formula identifier (`<number>:<node>`, 257 chars) |

- `provideRootNonce`: generate a candidate, `put` with `ifAbsent: true`;
  if the conditional write loses, `get` the winner. This is race-safe and
  strictly stronger than the node implementation's read-then-write.
- `writeFormula`: unconditional `put` (parity with node, which overwrites;
  the daemon's serial mutation queue makes conflicting writes impossible
  in one process). DynamoDB's per-item atomic put also closes the node
  implementation's acknowledged gap (`writeFormula` carries a TODO about
  atomic rename; a torn JSON file cannot happen here).
- `readFormula`: consistent `get`; absent → `ReferenceError` with the
  same "No reference exists ..." message shape as node.
- Pet store creation: `query` the partition (paginated) to populate the
  in-memory multimap, exactly where node lists the directory.
- `write`/`remove`: single-item `put`/`delete`.
- `rename(from, to)`: `transact({ deletes: [from], puts: [to] })` —
  atomic delete+put, preserving `fs.rename`'s atomic-replace semantics
  (partial rename can never be observed, even across a crash).

Item sizes are far below DynamoDB's 400KB item limit (formulas are small
JSON; pet-name values are 257 bytes). Reads use `ConsistentRead` so a
daemon restarting immediately after a crash observes its own last writes,
matching filesystem semantics.

## S3 for the content-addressed store (and why S3)

Content keys: `<keyPrefix>store-sha512/<sha512hex>`, mirroring the node
platform's `store-sha512/` directory.

- **Why S3 and not DynamoDB**: blobs (bundles, arbitrary readables) exceed
  DynamoDB's 400KB item cap and want streaming reads; S3 objects are
  immutable-once-put, support ranged and streaming GET, and PUT visibility
  is atomic (no partially-written object is ever readable), which is
  precisely the content-address invariant.
- **Why not inline small values in DynamoDB**: it splits one content
  identity across two stores for a latency win the daemon does not need
  (blob reads are streamed over CapTP anyway). Considered and rejected for
  v1; the seam (`S3BlobPowers`) would admit it later without interface
  change.
- **Why not EFS**: a POSIX filesystem mount is just the node platform with
  a network disk; it forfeits S3's durability class and serverless account
  surface without simplifying anything.

`store(readable)` cannot know the content hash (the key) until the stream
ends, so it mirrors node's temp-file-then-rename dance with staging keys:

1. Stream to `<keyPrefix>staging/<randomHex512>` via `putBlobStream`
   (the SDK adapter uses `@aws-sdk/lib-storage` `Upload`, which handles
   buffering and multipart for unknown-length bodies; multipart completion
   is atomic), updating a SHA-512 digester per chunk.
2. If `hasBlob` reports the final content key already exists, delete the
   staging object (dedup: content already stored).
3. Otherwise `copyBlob` staging → `store-sha512/<digest>` (server-side,
   atomic visibility), then delete the staging object.

Concurrent stores of identical content race benignly: both copies write
identical bytes to the same key. Objects above 5GB would need multipart
copy; daemon blobs are orders of magnitude smaller, so single `CopyObject`
is v1, with the limit noted in the adapter.

`fetch(sha512)` is lazy: it builds the key and returns an `EndoReadable`
whose `streamBase64()` opens `getBlobStream` and wraps it with
`makeReaderRef` (base64 chunks over CapTP, same as node), and whose
`text()`/`json()` collect the same stream. A missing object surfaces as a
rejection at consumption time, matching node (where `fetch` of an unknown
hash returns a readable whose reads fail).

## Semantic gaps called out

| Filesystem semantics (node) | AWS mapping | Gap resolution |
| --- | --- | --- |
| `fs.rename` atomic replace (pet-store `rename`) | `TransactWriteItems` delete+put | equivalent atomicity; transaction cannot be observed half-applied |
| temp file + rename into content store | staging key + server-side copy | same invariant (only complete, hash-verified content visible) |
| serialized writes via in-process queue (`makeSerialJobs`) | unchanged (queue lives in the daemon core and `makeFilePowers`; DynamoDB ops are each atomic) | no cross-operation transaction needed |
| read-after-write on local disk | `ConsistentRead: true` on gets and the pet-store load query | eventual-consistency gap closed explicitly |
| root-nonce read-then-create (racy on node) | conditional put, read winner on loss | strictly stronger than node |
| `writeFormula` non-atomic file write (TODO in node) | atomic `PutItem` | gap in node closed on AWS |
| free local writes | every mutation is a network round trip | acceptable: mutations are already serialized and low-rate; the in-memory pet-store cache keeps reads local |
| one daemon owns one state directory | one daemon must own one (table, keyPrefix) pair | same exclusivity assumption, now unenforced by an OS; v1 documents it, a lease item is future work (§ Phases) |

## Provisioning and deployment reference

`initializePersistence()` verifies the table and bucket exist (and in a
permitted mode may create them: `CreateTable` with on-demand billing,
`CreateBucket` with default encryption). A reference deployment can use
the garden's AWS account (us-west-1), but provisioning is generic:
one table, one bucket, one IAM policy granting exactly the operations in
§ The injected client powers against those two resources. Worker state,
logs, PID files, and the private socket stay on the local filesystem
(`DaemonicControlPowers` and `NetworkPowers` remain the node
implementations): the AWS platform is durable-state-in-AWS,
ephemeral-runtime-local.

## Test plan

- **Hermetic (this scaffold, runs in CI)**: `test/aws-emulator.js`
  implements `DynamoTablePowers` and `S3BlobPowers` in memory with the
  documented semantics (conditional put, atomic transact, staging-copy
  visibility). `test/daemon-aws.test.js` proves the storage interface
  against it: root-nonce idempotence and creation race; formula
  round-trip and missing-formula `ReferenceError`; content-store
  round-trip, dedup, staging cleanup, and `streamBase64` chunk framing;
  pet-store write/list/identify/reverseIdentify/remove/rename and
  `followNameChanges` (current-then-subsequent).
- **Emulator fidelity**: the same tests can run against dynamodb-local
  plus MinIO through the SDK adapter (Phase 2), which checks the
  emulator's semantics against real implementations.
- **Live smoke (opt-in)**: the identical suite pointed at a real table and
  bucket, gated behind explicit env config, never in CI by default.

## Phased build plan

1. **This design + scaffold** (this change): design doc, platform
   factories, SDK adapter, in-memory emulator, unit tests. No daemon-core
   edits, no new dependencies.
2. **Full daemon boot on AWS storage**: wire `daemon-aws.js` into the
   endo CLI's daemon-spawn path behind config; parameterize the daemon
   test suite over platforms; run it against dynamodb-local + MinIO.
3. **Reference deployment**: provisioning script (table, bucket,
   least-privilege IAM policy), operational docs, cost notes; validate
   against a real account.
4. **Multi-instance safety and operations**: a lease/lock item to enforce
   the single-owner assumption, backup/restore posture (point-in-time
   recovery, bucket versioning), key rotation guidance.

## Considered and rejected

- **Aurora DSQL / RDS in place of DynamoDB.** Rejected: the daemon's
  structured state is three small KV shapes with one two-key transaction;
  a relational engine adds operational surface without buying semantics
  the seam needs.
- **DynamoDB-only (blobs inlined).** Rejected: 400KB item cap and no
  streaming reads.
- **S3-only (pet names and formulas as objects).** Rejected: no atomic
  two-key rename, no conditional create-if-absent transaction pairing,
  and per-name GETs would make store loading O(names) round trips.
- **SDK command pass-through powers.** Rejected: puts DynamoDB expression
  grammar inside the trusted path and makes the emulator implement a
  parser; semantic powers keep both sides small (§ The injected client
  powers).

## Open questions

- Should the AWS platform live in `packages/daemon/src/` (as scaffolded,
  parallel to `daemon-node-powers.js`, zero new dependencies thanks to
  SDK injection) or in a separate `@endo/daemon-aws` package that takes
  real `@aws-sdk/*` dependencies? The scaffold's placement follows the
  maintainer's "peer of node / web / endo" framing; a package split
  remains cheap later because nothing outside the three new files knows
  about AWS.
- Should `initializePersistence` be allowed to create the table and
  bucket, or only verify them (leaving creation to provisioning)? The
  scaffold verifies and reports; creation is Phase 3.
- Does the daemon want a platform-neutral name for the storage seam
  (`DaemonicPersistencePowers` + `PetStorePowers` extracted into a
  documented "storage platform" contract) once two non-filesystem
  platforms (AWS, CloudFlare) exist? The two sibling designs are kept
  interface-identical to make that extraction mechanical.
