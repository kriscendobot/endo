---
'@endo/daemon': minor
---

Add an experimental AWS storage platform, a peer of the node platform:
DynamoDB carries the structured state (root nonce, formulas, pet-name
graphs) and S3 carries the content-addressed blob store, behind the
existing `DaemonicPersistencePowers` and `PetStorePowers` interfaces.
The daemon core is unchanged, and `@endo/daemon` takes no AWS dependency:
the platform factories (`src/daemon-aws-powers.js`) consume narrow
injected client powers, the SDK adapters (`src/daemon-aws-sdk.js`)
receive the AWS SDK v3 module namespaces as parameters, and only the new
`daemon-aws.js` entry point dynamically imports the SDK, which is an
optional peer. Design document: `packages/daemon/docs/aws-storage.md`.
