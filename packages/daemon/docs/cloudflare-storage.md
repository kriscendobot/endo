# Cloudflare storage platform for the Endo daemon

Status: DESIGN (with a runnable toy scaffold).
Scope: the daemon's **storage** powers on Cloudflare primitives.
The Workers/Durable-Object *execution* story (workers, sockets, CapTP) is
surfaced but deliberately out of scope.

This document is a peer of the AWS storage-platform design and implements the
same pre-existing daemon storage interface; where the two designs make
analogous choices they should stay consistent (see § Consistency with the AWS
sibling).

## 1. The storage interface as it actually is

The daemon core (`src/daemon.js`) is platform-agnostic. It receives one object,
`DaemonicPowers` (`src/types.d.ts`), from a platform entry module — today
`daemon-node.js` assembling `daemon-node-powers.js`. The storage-relevant
members:

- **`CryptoPowers`** — `makeSha512()` returning an **incremental, synchronous**
  digester (`update`, `updateText`, `digestHex`), and `randomHex512()`.
  Formula numbers, node identity derivation, and content addressing all flow
  through this.
- **`PetStorePowers.makeIdentifiedPetStore(formulaNumber, formulaType,
  assertValidName)`** — a named mapping store (`pet-store` /
  `known-peers-store` / `mailbox-store`) from pet names to formula
  identifiers, with `has` / `identifyLocal` / `reverseIdentify` / `list` /
  `write` / `remove` / `rename` and two change-subscription surfaces
  (`followNameChanges`, `followIdNameChanges`). The implementation
  (`src/pet-store.js`) keeps an in-memory bidirectional multimap loaded from
  storage at construction and persists one small text record per name.
- **`DaemonicPersistencePowers`** —
  - `initializePersistence()` — create the state roots.
  - `provideRootNonce()` — read-or-create the daemon's root entropy; must be
    **once-only**: all identities derive from it.
  - `makeContentSha512Store()` — a **content-addressed blob store**:
    `store(readable)` streams `Uint8Array` chunks, hashes them (SHA-512) while
    spooling, and finishes by making the content readable under its hash —
    on node, a stream to a random temp file completed by an **atomic
    rename** to the hash-named file; `fetch(sha512)` returns an
    `EndoReadable` (`sha512()`, `streamBase64()`, `text()`, `json()`).
  - `readFormula(number)` / `writeFormula(number, formula)` — small JSON
    **formula** records keyed by a 128-hex formula number; written once at
    formulation, read at revival. Node shards them as
    `formulas/<hh>/<rest>.json` files. (The node `writeFormula` carries a
    `TODO` to make the write atomic; this design treats atomic formula
    writes as a requirement, not an accident.)

**Correction to the mandate:** the node implementation uses **no sqlite3 at
all**. It is filesystem + crypto throughout: formulas are JSON files, the
content store is hash-named files with atomic rename, pet stores are
directories of one-name-per-file records (`daemon-node-powers.js`,
`pet-store.js`). "Port the sqlite store to D1" is therefore not the shape of
the job; the job is to give the *file-shaped* small-record stores a
transactional home and the *stream-shaped* content store an object-storage
home. That said, SQL is a genuinely better home for the small records than
key-emulated files — it removes the node implementation's known atomicity
gaps (`writeFormula` TODO; multi-step `rename`) rather than merely preserving
them.

Semantics the platform must preserve:

| Semantic | Where it lives on node | Requirement |
| --- | --- | --- |
| Root nonce once-only | read-then-write of a `nonce` file (racy across processes; node relies on single daemon process) | must be atomic read-or-create |
| Formula write | plain file write (TODO atomic) | atomic; write-once in practice |
| Content store finish | temp file + atomic rename | reader never observes a partial object under a hash name |
| Content addressing | SHA-512 of the exact byte stream | identical hashing; dedup is free and races are benign (same bytes) |
| Pet `rename` | single `fs.rename` | old name gone and new name bound in one step |
| Pet store load | `readdir` + read each file at store construction | enumerable per-store listing |
| Write serialization | `makeSerialJobs` per powers object, single daemon process | a single serialized writer per daemon |
| Streams | `Reader`/`Writer` of `Uint8Array`; base64 chunks over CapTP via `makeReaderRef` | same stream discipline; range reads desirable |

## 2. Mapping onto Cloudflare primitives

Evaluated per store, against the table above:

- **D1** (serverless SQLite): the right *family* for formulas, pet names, and
  the nonce — single-writer SQLite, SQL schema, atomic single statements, and
  atomic multi-statement `batch()` (D1 executes a batch as one implicit
  transaction, rolled back on error). Constraint to respect: **no interactive
  transactions** (no BEGIN…application logic…COMMIT across round trips) —
  every transactional unit must be expressible as a single statement or a
  prepared batch. Every transactional need in § 1 fits that shape.
- **Durable Object SQLite storage** (`ctx.storage.sql`): the *closest* analog
  of all — an actual SQLite database, **synchronous** API, implicit
  atomicity around each event-loop turn plus `transactionSync`, colocated
  with the single DO instance. Strictly stronger semantics than D1, but only
  reachable *from inside a Durable Object*.
- **R2** (S3-compatible object storage): the content-addressed store. Streamed
  puts, range `get`s, per-key atomic visibility (a `put` becomes visible
  all-or-nothing; R2 is strongly consistent), multipart uploads for large
  objects. The one missing piece versus the filesystem is **rename** — the
  Workers binding has no server-side copy — which § 4.3 designs around.
- **Workers KV**: **rejected** for all authoritative state — eventual
  consistency (a read after write may return stale data at another location)
  breaks read-your-writes for every store above. Admissible later as a
  read-through cache for immutable content-addressed blobs (they cannot go
  stale), never as the source of truth.
- **Durable Objects as coordination**: required regardless of the SQL choice —
  see next section.

### 2.1 The single-writer question decides the architecture

The daemon assumes **exclusive ownership of its state by one live instance**:
`daemon.js` memoizes formulas and controllers in maps, `pet-store.js` caches
the whole name table in memory, `formulaGraphJobs`/`makeSerialJobs` serialize
mutations *within one process*, and on node a pid file lets a new daemon kill
the old. Plain Workers give the opposite: many concurrent isolates across
locations, none authoritative.

**Only a Durable Object provides the node-daemon's implicit guarantee** — a
single named instance, globally, with serialized event delivery (input/output
gates). Therefore: *whatever* SQL backend is chosen, **the daemon's storage
powers must be exercised from inside a single DO** ("the daemon DO"). D1
without a DO in front is not a viable deployment of the *daemon*, only of
offline inspection tooling.

Given that the daemon already must live in a DO, the recommendation:

- **Primary: DO SQLite storage** for formulas, pet names, nonce — colocated,
  synchronous, interactive transactions, 10 GB capacity class, point-in-time
  recovery. The nearest thing Cloudflare has to "the daemon's own sqlite
  file".
- **Alternative profile: D1** behind the same adapter seam — chosen when the
  operator wants daemon state inspectable/queryable outside the DO (wrangler
  `d1 execute`, dashboards, exports) or shared with non-DO tooling. The
  schema and every statement in this design run identically on both (both are
  SQLite; the adapter confines the API differences).
- **R2 in both profiles** for content-addressed blobs. Blobs do not belong in
  SQL rows: the content store is stream-shaped, objects can reach hundreds of
  MB, and R2 `get` gives range reads and streaming bodies.

## 3. Powers architecture (the seams)

Two narrow injected capability interfaces isolate every Cloudflare API from
the logic, keeping the logic testable anywhere and the daemon core untouched:

```
SqlPowers            — init, get, all, run, batch (atomic)
BlobPowers           — put, get (streaming, ranged), head, delete, list(prefix)
```

with thin adapters:

```
makeSqlPowersFromD1(d1Database)                    // D1 binding
makeSqlPowersFromDurableObjectStorage(ctx.storage) // DO SQLite (sync exec, transactionSync)
makeBlobPowersFromR2(r2Bucket)                     // R2 binding
```

On top of those, the platform module `daemon-cloudflare-powers.js` provides:

- `makeCloudflareCryptoPowers({ makeSha512 })` — `randomHex512` from
  `globalThis.crypto.getRandomValues` (present on Workers and modern node);
  `makeSha512` is **injected** because the interface requires a *synchronous,
  incremental* digester: WebCrypto's `subtle.digest` is one-shot/async and
  workerd's nonstandard `crypto.DigestStream` is async at the finish, so the
  build phase should inject `@noble/hashes/sha512` (pure JS, sync,
  incremental, auditable) in the Worker, while node-side tests inject
  `node:crypto`.
- `makeSqlFilePowers(sqlPowers)` — a `FilePowers` implementation over one
  SQL table of small text records (§ 4.1). This is the key reuse move: it
  lets the **unmodified** `makePetStoreMaker` (`src/pet-store.js`) run on
  Cloudflare — all ~280 lines of name-table, multimap, and
  change-subscription logic are shared with node rather than forked. The
  operations `pet-store.js` actually uses (`readFileText`, `writeFileText`,
  `removePath`, `renamePath`, `readDirectory`, `makePath`, `joinPath`) all
  map to single atomic SQL statements — `renamePath` becomes one `UPDATE`,
  *stronger* than the node original.
- `makeCloudflareDaemonicPersistencePowers({ sqlPowers, blobPowers,
  cryptoPowers })` — nonce and formulas natively on SQL (§ 4.2), content
  store on R2 (§ 4.3).
- `makeCloudflareDaemonicPowers({ sql, blobs, makeSha512 })` — assembles
  `{ crypto, petStore, persistence, control }`; `control` is a stub that
  throws with a pointer to the runtime design gap (§ 6).

No Cloudflare API is touched outside the three adapters. No ambient
authority: an account, database id, or bucket name never appears in the
platform module — only live binding objects, injected (§ 7).

## 4. Storage design

### 4.1 SQL schema (identical on D1 and DO SQLite)

```sql
-- One-value table for the root nonce (and future singletons).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Formula records, keyed by 128-hex formula number.
CREATE TABLE IF NOT EXISTS formulas (
  number  TEXT PRIMARY KEY,
  formula TEXT NOT NULL          -- JSON
);

-- Small-text-file emulation backing makeSqlFilePowers, used by the
-- unmodified pet-store.js. Path shape mirrors the node layout:
-- <root>/<formula-type>/<hh>/<rest-of-number>/<pet-name>
CREATE TABLE IF NOT EXISTS files (
  path    TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
```

Why a path-keyed `files` table rather than a normalized
`pet_names(store_type, store_number, name, id)` relation: it is what lets
`pet-store.js` run unmodified. The normalized relation would require forking
the pet-store logic into a second implementation that must then be kept in
lockstep with node's. The path table costs one `LIKE 'prefix/%'` scan per
store construction (bounded by an index range scan on the primary key; pet
stores are small) and buys zero drift. If the daemon later grows a native
`PetStore` port, the relation is the obvious refactor — noted as a
non-blocking follow-up.

### 4.2 Nonce and formulas

- `provideRootNonce()` — generate a candidate nonce, then atomically:
  `INSERT INTO meta(key, value) VALUES ('rootNonce', ?) ON CONFLICT(key) DO
  NOTHING`, then `SELECT`. On D1 the two statements ride one `batch()`
  (transactional); on DO SQLite they run inside `transactionSync`.
  `isNewlyCreated` falls out of whether the insert changed a row. This is
  strictly safer than node's read-then-write, which relied on the pid-file
  process discipline.
- `writeFormula(number, formula)` — single
  `INSERT INTO formulas ... ON CONFLICT(number) DO UPDATE` (an upsert, since
  the daemon may legitimately re-`preformulate` well-known formulas at every
  boot). Atomic — resolves the node TODO.
- `readFormula(number)` — `SELECT`; absence throws `ReferenceError`-shaped
  errors matching the node behavior, corruption throws `TypeError`.

Formula JSON is small (identifiers and option records); no D1/DO row-size
ceiling is in play, but the build phase should verify current documented
per-row and per-statement limits and add a guard with a clear error rather
than relying on this assumption silently.

### 4.3 Content-addressed store on R2

Key layout, under a configurable prefix (default mirrors node):

```
store-sha512/<128-hex-sha512>     — committed content
store-sha512/tmp/<128-hex-random> — in-flight spool objects (GC-able)
```

`store(readable)`:

1. Consume the `Uint8Array` chunks, feeding the injected incremental SHA-512.
2. **Small path** (total ≤ threshold, default 32 MiB — comfortably inside the
   128 MiB Worker memory budget): buffer, then a single `put` at the final
   `store-sha512/<hash>` key. Single-key `put` is atomic and idempotent —
   concurrent stores of the same content write the same bytes to the same
   key; last-write-wins is harmless.
3. **Large path** (build phase): spool chunks into an R2 **multipart upload**
   at a `tmp/<random>` key while hashing; on completion, since the Workers R2
   binding offers no server-side rename/copy, **re-stream** `get(tmp)` →
   multipart `put(store-sha512/<hash>)` and delete the spool. Cost: one extra
   read+write pass through the Worker, bounded memory. If a HEAD of the final
   key shows the content already exists, skip the copy (dedup makes the
   second pass usually free in practice). Orphaned `tmp/` objects from
   crashed uploads are garbage: an R2 lifecycle rule on the `tmp/` prefix
   (age-based abort/expiry) reaps them — no daemon bookkeeping required.
4. Return the hex digest, exactly as node does.

The atomic-visibility guarantee ("a reader never observes a partial object
under a hash name") holds in both paths because content only ever appears at
its final key via a completed `put`/multipart-complete — R2 makes objects
visible all-or-nothing and is strongly consistent.

`fetch(sha512)` → `EndoReadable`:

- `streamBase64()` — R2 `get(key).body` (a Web `ReadableStream`, asynchronously
  iterable in workerd and node) chunk-mapped through the daemon's existing
  `makeReaderRef` (base64 frames over CapTP), unchanged.
- `text()` / `json()` — R2's own `text()`; JSON parse mirrors node.
- Absence surfaces as an error at first read, matching the node behavior of a
  failing file open (lazy).
- **Range reads**: R2 `get` accepts `{ range: { offset, length } }`, which the
  `BlobPowers.get` seam exposes; nothing in today's `EndoReadable` consumes
  ranges yet, but the seam means a future `readAt`/partial-read power costs
  no redesign. (The AWS sibling should expose the same seam over S3
  `Range:` gets.)

### 4.4 Pet stores

`makePetStoreMaker(makeSqlFilePowers(sqlPowers), config)` — the daemon-core
module, unmodified. Store paths land in the `files` table as
`state/<formula-type>/<hh>/<rest>/<name>` rows with the formula identifier as
content. `rename` is one `UPDATE files SET path = ?2 WHERE path = ?1`.
Construction lists the store's directory via a ranged `LIKE` and rebuilds the
in-memory multimap, same as node rebuilds from `readdir`.

Change subscriptions (`followNameChanges` / `followIdNameChanges`) are
**in-memory topics** in `pet-store.js`; § 6 covers what DO eviction does to
them.

## 5. Semantic gap analysis

| Concern | node | Cloudflare (this design) | Verdict |
| --- | --- | --- | --- |
| Nonce once-only | read-then-write, guarded by process discipline | atomic upsert in one transaction | improved |
| Formula write atomicity | non-atomic write (open TODO) | single upsert statement | improved |
| Pet rename atomicity | `fs.rename` (atomic) | single `UPDATE` (atomic) | preserved |
| Content-store commit | temp file + atomic rename | atomic single put (small) / spool + re-stream + atomic put (large) | preserved; large path costs an extra pass |
| Interactive transactions | sqlite-style available in principle, unused | D1: batch-only; DO SQLite: `transactionSync` | sufficient — every unit in this design is single-statement or batchable |
| Write serialization | one process + `makeSerialJobs` | one DO instance + serialized events + same `makeSerialJobs` | preserved (stronger: platform-enforced) |
| Durability/backup | whatever the host filesystem gives | R2 + D1/DO storage replication; DO PITR | improved |
| Listing a store | `readdir` | primary-key range scan | preserved |
| Hash discipline | node `crypto` SHA-512 | injected sync incremental SHA-512 (`@noble/hashes`) | preserved byte-for-byte |
| Blob size ceiling | filesystem | single-put path bounded by Worker memory; multipart path to R2's multi-GB/TB limits | build-phase work for the large path |

## 6. Runtime implications (surfaced, out of scope)

Storage is the tractable half. A Workers/DO-hosted daemon also needs:

- **No processes**: `DaemonicControlPowers.makeWorker` forks a node child over
  netstring-CapTP pipes. Workers cannot fork. The natural analog — each Endo
  worker as its own DO or dynamically-dispatched Worker (isolate-per-worker,
  which is philosophically *closer* to Endo's compartment model than node
  child processes) speaking CapTP over WebSocket or RPC bindings — is a
  separate design. This scaffold stubs `control` with an explanatory throw.
- **No Unix sockets / listeners**: `NetworkPowers` (private path service,
  incoming CapTP) must become a DO `fetch`/WebSocket surface. DO WebSocket
  hibernation changes connection lifetime assumptions.
- **Eviction vs. in-memory state**: a DO can be evicted/hibernated at any
  quiet moment. Everything *persistent* in this design reloads correctly
  (pet-store multimaps rebuild from SQL; formula memos refill lazily) — but
  **live subscriptions** (`followNameChanges`, pubsub topics, CapTP sessions)
  are in-memory and drop on eviction. Storage is eviction-safe; the session
  layer above it must be designed for reconnection.
- **Lifecycle**: no pid file, no SIGINT; DO identity replaces process
  arrogation (an improvement — the platform guarantees the singleton instead
  of a kill-the-predecessor protocol).
- **SES/lockdown on workerd**: `daemon.js` runs under `@endo/init`. Endo's
  lockdown on workerd is its own compatibility track and gates any *hosted*
  daemon; it does not gate the storage powers, which are SES-clean plain
  modules.
- **Budgets**: 128 MiB memory (drives the § 4.3 threshold), CPU-time limits
  per invocation (long streams should ride streaming APIs, not buffering),
  and D1/R2 per-statement/object limits to verify at build time.

## 7. Config and powers injection

No ambient authority, account-agnostic — Cloudflare **bindings are already
capabilities** (unforgeable objects injected into the Worker/DO `env`, scoped
by `wrangler.toml`, no account ids or keys in code), which lines up exactly
with Endo's powers-injection discipline:

```js
// wrangler.toml (deployment-owned, not code-owned):
//   [[d1_databases]]  binding = "ENDO_DB"    ...   # profile B only
//   [[r2_buckets]]    binding = "ENDO_BLOBS" ...
//   [[durable_objects.bindings]] name = "ENDO_DAEMON" class_name = "EndoDaemon"

export class EndoDaemon /* extends DurableObject */ {
  constructor(ctx, env) {
    const sql = makeSqlPowersFromDurableObjectStorage(ctx.storage); // profile A
    // const sql = makeSqlPowersFromD1(env.ENDO_DB);                // profile B
    const blobs = makeBlobPowersFromR2(env.ENDO_BLOBS);
    this.powers = makeCloudflareDaemonicPowers({ sql, blobs, makeSha512 });
    // makeDaemon(this.powers, ...) — runtime track, § 6
  }
}
```

The node `Config` (`statePath`, `ephemeralStatePath`, `cachePath`, `sockPath`)
degenerates to logical key prefixes: state lives under the injected bindings,
ephemeral state is the DO's in-memory lifetime, and there is no socket path.
The platform module accepts an optional `{ statePrefix, blobPrefix }` and
defaults to the node-mirroring names so a state dump reads familiarly.

## 8. Module shape and packaging

Following the `daemon-node-powers.js` / `daemon-node.js` convention:

- `src/daemon-cloudflare-powers.js` — everything in § 3 (this branch,
  scaffolded).
- `src/daemon-cloudflare.js` — the DO entry (`EndoDaemon` class, § 7 sketch)
  — **build phase**, because it is runtime-track work and would drag
  Cloudflare ambient types into the package's typecheck today.
- Tests under `test/` (§ 9).

The powers module imports only platform-neutral daemon-package modules
(`pet-store.js`, `reader-ref.js`, `@endo/hex`, `@endo/errors`, `@endo/harden`)
— nothing node-flavored — so it loads on workerd as-is. Whether the platform
ultimately ships in `@endo/daemon` or as a sibling `@endo/daemon-cloudflare`
package (keeping wrangler/miniflare devDependencies out of the daemon) is a
packaging decision for the build phase; the code is placed so either works.
The AWS sibling should make the same call the same way.

## 9. Toy scaffold and tests (on this branch)

- `src/daemon-cloudflare-powers.js` — the real platform module: SqlPowers /
  BlobPowers seams, D1 + DO-storage + R2 adapters, SQL file powers, crypto
  powers, persistence powers, pet-store reuse, powers assembly.
- `test/cloudflare-mock-bindings.js` — **in-memory stand-ins for the
  Cloudflare binding APIs**: a mock D1 database backed by **`node:sqlite`**
  (real SQLite semantics — the same SQL engine family the production targets
  run — with `prepare/bind/first/all/run/batch` in the D1 shapes, batch-as-
  transaction included) and a mock R2 bucket (Map-backed, `put/get/head/
  delete/list` subset with streaming bodies).
- `test/cloudflare-powers.test.js` — AVA (repo conventions: `@endo/init`
  perimeter first), exercising through the mock bindings: nonce
  create/idempotence/persistence, formula write/read/upsert and
  missing-formula errors, pet-store write/list/identify/reverseIdentify/
  rename/remove **plus reload-from-storage** (a fresh powers object over the
  same database sees the persisted names), and content-store round trips
  (digest equality against an independent node-crypto reference, dedup
  idempotence, `text`/`json`/`streamBase64` decode).

**Emulator statement (required by the mandate):** this branch's tests run
against the in-memory mock bindings above — chosen so the toy runs inside the
endo repo's stock AVA setup with zero new dependencies (`node:sqlite` is
built in). They mirror the Workers binding call shapes exactly, so the same
suite is designed to be re-pointed at **Miniflare 3 / workerd** (which
locally emulates real D1, R2, and DO SQLite) in the build phase; that rig —
plus `wrangler dev` against a real account as the final proof — is the first
build-job task rather than part of this design branch, to keep heavyweight
Cloudflare tooling out of the monorepo's dependency graph until the
maintainers opt in.

## 10. Phased build plan

1. **Phase 1 — real-runtime verification.** Add a `@cloudflare`-tooling dev
   harness (Miniflare 3 programmatic API or `@cloudflare/vitest-pool-workers`
   — decide against repo norms, AVA-first); run the § 9 suite on workerd with
   real local D1/R2/DO-SQLite; inject `@noble/hashes` SHA-512; verify the
   documented D1/R2/DO limits and encode them as guards.
2. **Phase 2 — large-blob path.** R2 multipart spool + re-stream commit,
   `tmp/` lifecycle rule, threshold tuning, ranged `BlobPowers.get`.
3. **Phase 3 — the daemon DO.** `src/daemon-cloudflare.js` (`EndoDaemon` DO
   class), `provideRootNonce`-through-`makeDaemon` boot on workerd, SES
   lockdown on workerd cleared, WebSocket CapTP ingress replacing the Unix
   socket, eviction/reconnect story for subscriptions.
4. **Phase 4 — control powers.** Endo workers as DOs / dynamic Workers;
   isolate-per-worker CapTP; this is where the platform stops being
   storage-only.

Phases 1–2 are pure storage-platform work and independent of 3–4.

## 11. Consistency with the AWS sibling

Both platforms implement the same interfaces behind the same kind of seams.
Expected correspondences: DO-SQLite/D1 ↔ the AWS structured-store choice
(e.g. DynamoDB or Aurora/RDS-sqlite-analog), R2 ↔ S3 (R2 is S3-API-
compatible, so the content-store key layout and range-read seam should be
identical), bindings-injection ↔ injected AWS SDK clients/credentials. The
two designs should converge on: the same key/path layout, the same
`SqlPowers`/`BlobPowers`-style seam names where applicable, the same
placement (`src/daemon-<platform>-powers.js`, `docs/<platform>-storage.md`),
and the same packaging decision. Coordination is live on the garden message
bus between the two design jobs.

## 12. Open questions

- **D1 vs DO SQLite as the *default*** once the daemon DO exists: this design
  says DO SQLite; if operators want external inspectability by default, flip
  the adapter — nothing else changes.
- **Row/statement/object limits**: verified and guard-coded in Phase 1 rather
  than trusted from documentation snapshots here.
- **KV as blob cache**: only if measured R2 latency at the daemon DO's
  location warrants it; immutable-only.
- **Normalized pet-name relation**: worthwhile only if node also moves off
  file-per-name; keep the implementations congruent.
- **Packaging** (in `@endo/daemon` vs `@endo/daemon-cloudflare`): decide with
  upstream maintainers at PR time, jointly with the AWS sibling.
