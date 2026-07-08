// @ts-check
/* global process */

// The AWS platform's daemon entry point, parallel to `daemon-node.js`:
// the daemon runs on Node (workers, sockets, and crypto are the node
// implementations) while durable state lives in DynamoDB and S3 (see
// `daemon-aws-powers.js` and `docs/aws-storage.md`).
//
// Configuration arrives by environment; credentials resolve through the
// SDK's standard provider chain on the constructed clients, and only the
// narrow client powers reach the daemon:
//   ENDO_AWS_TABLE   (required) DynamoDB table (pk HASH / sk RANGE strings)
//   ENDO_AWS_BUCKET  (required) S3 bucket for the content-addressed store
//   ENDO_AWS_REGION  (optional) forwarded to the SDK clients
//   ENDO_AWS_KEY_PREFIX (optional) S3 key prefix, for sharing a bucket

// Establish a perimeter:
import '@endo/init';

import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import popen from 'child_process';
import url from 'url';

import { makePromiseKit } from '@endo/promise-kit';
import { makeDaemon } from './daemon.js';
import {
  makeFilePowers,
  makeNetworkPowers,
  makeCryptoPowers,
} from './daemon-node-powers.js';
import { makeDaemonicAwsPowers } from './daemon-aws-powers.js';
import {
  makeDynamoTablePowersFromSdk,
  makeS3BlobPowersFromSdk,
} from './daemon-aws-sdk.js';

const fsp = { access: fs.promises.access };

/** @import { PromiseKit } from '@endo/promise-kit' */
/** @import { Config, Builtins } from './types.js' */

if (process.argv.length < 5) {
  throw new Error(
    `daemon-aws.js requires arguments [sockPath] [statePath] [ephemeralStatePath] [cachePath], got ${process.argv.join(
      ', ',
    )}`,
  );
}

const [sockPath, statePath, ephemeralStatePath, cachePath] =
  process.argv.slice(2);

/** @type {Config} */
const config = {
  sockPath,
  statePath,
  ephemeralStatePath,
  cachePath,
};

const tableName = process.env.ENDO_AWS_TABLE;
const bucketName = process.env.ENDO_AWS_BUCKET;
const region = process.env.ENDO_AWS_REGION;
const keyPrefix = process.env.ENDO_AWS_KEY_PREFIX || '';
if (!tableName || !bucketName) {
  throw new Error(
    'daemon-aws.js requires environment variables ENDO_AWS_TABLE and ENDO_AWS_BUCKET',
  );
}

/**
 * The SDK is an optional peer of `@endo/daemon`: it is imported only here,
 * only at daemon start, and handed to the adapters as parameters.
 */
const loadAwsSdk = async () => {
  // No synchronous preamble.
  await null;

  /* eslint-disable import/no-unresolved */
  try {
    const [dynamodbSdk, s3Sdk, libStorage] = await Promise.all([
      // @ts-ignore The SDK is an optional peer, not a dependency.
      import('@aws-sdk/client-dynamodb'),
      // @ts-ignore The SDK is an optional peer, not a dependency.
      import('@aws-sdk/client-s3'),
      // @ts-ignore The SDK is an optional peer, not a dependency.
      import('@aws-sdk/lib-storage'),
    ]);
    /* eslint-enable import/no-unresolved */
    return { dynamodbSdk, s3Sdk, libStorage };
  } catch (cause) {
    throw new Error(
      'daemon-aws.js requires the packages @aws-sdk/client-dynamodb, @aws-sdk/client-s3, and @aws-sdk/lib-storage to be installed',
      { cause },
    );
  }
};

const { pid, kill } = process;

const networkPowers = makeNetworkPowers({ net, fsp });
const filePowers = makeFilePowers({ fs, path });
const cryptoPowers = makeCryptoPowers(crypto);

const informParentWhenReady = () => {
  if (process.send) {
    process.send({ type: 'ready' });
  }
};

const reportErrorToParent = message => {
  if (process.send) {
    process.send({ type: 'error', message });
  }
};

const { promise: cancelled, reject: cancel } =
  /** @type {PromiseKit<never>} */ (makePromiseKit());

const updateRecordedPid = async () => {
  const pidPath = filePowers.joinPath(ephemeralStatePath, 'endo.pid');

  await filePowers
    .readFileText(pidPath)
    .then(pidText => {
      const oldPid = Number(pidText);
      kill(oldPid);
    })
    .catch(() => {});

  await filePowers.writeFileText(pidPath, `${pid}\n`);
};

const main = async () => {
  const daemonLabel = `daemon on PID ${pid} (AWS storage)`;
  console.log(`Endo daemon starting on PID ${pid} with AWS storage`);
  cancelled.catch(() => {
    console.log(`Endo daemon stopping on PID ${pid}`);
  });

  const { dynamodbSdk, s3Sdk, libStorage } = await loadAwsSdk();
  const clientConfig = region === undefined ? {} : { region };
  const tablePowers = makeDynamoTablePowersFromSdk({
    dynamodbSdk,
    client: new dynamodbSdk.DynamoDBClient(clientConfig),
    tableName,
  });
  const blobPowers = makeS3BlobPowersFromSdk({
    s3Sdk,
    libStorage,
    client: new s3Sdk.S3Client(clientConfig),
    bucketName,
    keyPrefix,
  });

  const powers = makeDaemonicAwsPowers({
    config,
    fs,
    popen,
    url,
    filePowers,
    cryptoPowers,
    tablePowers,
    blobPowers,
  });
  const { persistence: daemonicPersistencePowers } = powers;

  // Worker state, logs, and the private socket remain local; only durable
  // state lives in AWS, so the local state directories are still needed.
  await filePowers.makePath(statePath);
  await filePowers.makePath(ephemeralStatePath);
  await filePowers.makePath(cachePath);
  await daemonicPersistencePowers.initializePersistence();

  const { endoBootstrap, cancelGracePeriod } = await makeDaemon(
    powers,
    daemonLabel,
    cancel,
    cancelled,
    {
      /** @param {Builtins} builtins */
      APPS: ({ MAIN, NONE }) => ({
        type: /** @type {const} */ ('make-unconfined'),
        worker: MAIN,
        powers: NONE,
        specifier: new URL('web-server-node.js', import.meta.url).href,
      }),
    },
  );

  /** @param {Error} error */
  const exitWithError = error => {
    cancel(error);
    cancelGracePeriod(error);
  };

  // Start network services
  const privatePathService = networkPowers.makePrivatePathService(
    endoBootstrap,
    sockPath,
    cancelled,
    exitWithError,
  );
  const services = [privatePathService];
  await Promise.all(services.map(({ started }) => started)).then(
    () => {
      informParentWhenReady();
    },
    error => {
      reportErrorToParent(error.message);
      throw error;
    },
  );
  const servicesStopped = Promise.all(services.map(({ stopped }) => stopped));

  // Record self as official daemon process
  await updateRecordedPid();

  // Wait for services to end normally
  await servicesStopped;
  cancel(new Error('Terminated normally'));
  cancelGracePeriod(new Error('Terminated normally'));
};

process.once('SIGINT', () => cancel(new Error('SIGINT')));

// @ts-ignore Yes, we can assign to exitCode, typedoc.
process.exitCode = 1;
main().then(
  () => {
    process.exitCode = 0;
  },
  error => {
    console.error(error);
  },
);
