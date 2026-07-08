// @ts-check
// Adapters from AWS SDK v3 clients to the narrow client powers consumed by
// `daemon-aws-powers.js`. This is the only module that speaks SDK command
// shapes, and even here the SDK arrives as parameters (module namespaces
// and constructed clients), so `@endo/daemon` carries no AWS dependency:
// the entry point (`daemon-aws.js`) dynamically imports the SDK and passes
// it in. Design: `docs/aws-storage.md`.

import harden from '@endo/harden';

/** @import { DynamoTablePowers, S3BlobPowers } from './daemon-aws-powers.js' */

/**
 * @param {object} opts
 * @param {any} opts.dynamodbSdk - The `@aws-sdk/client-dynamodb` module namespace.
 * @param {any} opts.client - A constructed DynamoDBClient (carries region and credentials).
 * @param {string} opts.tableName
 * @returns {DynamoTablePowers}
 */
export const makeDynamoTablePowersFromSdk = ({
  dynamodbSdk,
  client,
  tableName,
}) => {
  const {
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
    QueryCommand,
    TransactWriteItemsCommand,
  } = dynamodbSdk;

  /** @type {DynamoTablePowers['put']} */
  const put = async ({ pk, sk, value, ifAbsent = false }) => {
    // No synchronous preamble.
    await null;

    try {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: pk },
            sk: { S: sk },
            value: { S: value },
          },
          ...(ifAbsent
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {}),
        }),
      );
      return { applied: true };
    } catch (error) {
      if (
        ifAbsent &&
        /** @type {Error} */ (error).name === 'ConditionalCheckFailedException'
      ) {
        return { applied: false };
      }
      throw error;
    }
  };

  /** @type {DynamoTablePowers['get']} */
  const get = async ({ pk, sk }) => {
    const result = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk }, sk: { S: sk } },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined ? undefined : result.Item.value.S;
  };

  /** @type {DynamoTablePowers['delete']} */
  const deleteItem = async ({ pk, sk }) => {
    await client.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk }, sk: { S: sk } },
      }),
    );
  };

  /** @type {DynamoTablePowers['query']} */
  const query = async ({ pk, cursor }) => {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ConsistentRead: true,
        ...(cursor === undefined
          ? {}
          : { ExclusiveStartKey: JSON.parse(cursor) }),
      }),
    );
    const items = (result.Items || []).map(item => ({
      sk: item.sk.S,
      value: item.value.S,
    }));
    return {
      items,
      ...(result.LastEvaluatedKey === undefined
        ? {}
        : { cursor: JSON.stringify(result.LastEvaluatedKey) }),
    };
  };

  /** @type {DynamoTablePowers['transact']} */
  const transact = async ({ deletes, puts }) => {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          ...deletes.map(({ pk, sk }) => ({
            Delete: {
              TableName: tableName,
              Key: { pk: { S: pk }, sk: { S: sk } },
            },
          })),
          ...puts.map(({ pk, sk, value }) => ({
            Put: {
              TableName: tableName,
              Item: {
                pk: { S: pk },
                sk: { S: sk },
                value: { S: value },
              },
            },
          })),
        ],
      }),
    );
  };

  return harden({
    put,
    get,
    delete: deleteItem,
    query,
    transact,
  });
};

/**
 * @param {object} opts
 * @param {any} opts.s3Sdk - The `@aws-sdk/client-s3` module namespace.
 * @param {any} opts.libStorage - The `@aws-sdk/lib-storage` module namespace
 * (provides `Upload`, the streaming/multipart put for bodies of unknown
 * length).
 * @param {any} opts.client - A constructed S3Client (carries region and credentials).
 * @param {string} opts.bucketName
 * @param {string} [opts.keyPrefix]
 * @returns {S3BlobPowers}
 */
export const makeS3BlobPowersFromSdk = ({
  s3Sdk,
  libStorage,
  client,
  bucketName,
  keyPrefix = '',
}) => {
  const {
    GetObjectCommand,
    HeadObjectCommand,
    CopyObjectCommand,
    DeleteObjectCommand,
  } = s3Sdk;
  const { Upload } = libStorage;

  /** @type {S3BlobPowers['putBlobStream']} */
  const putBlobStream = async ({ key, readable }) => {
    const upload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: `${keyPrefix}${key}`,
        Body: readable,
      },
    });
    await upload.done();
  };

  /** @type {S3BlobPowers['hasBlob']} */
  const hasBlob = async ({ key }) => {
    // No synchronous preamble.
    await null;

    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: bucketName,
          Key: `${keyPrefix}${key}`,
        }),
      );
      return true;
    } catch (error) {
      const { name } = /** @type {Error} */ (error);
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return false;
      }
      throw error;
    }
  };

  /** @type {S3BlobPowers['getBlobStream']} */
  const getBlobStream = async ({ key }) => {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `${keyPrefix}${key}`,
      }),
    );
    // In Node.js, Body is a Readable, which is an AsyncIterable<Uint8Array>.
    return result.Body;
  };

  /** @type {S3BlobPowers['copyBlob']} */
  const copyBlob = async ({ from, to }) => {
    // CopyObject is a single server-side copy, atomic in visibility, valid
    // for objects up to 5GB; larger objects would need multipart copy,
    // far beyond the size of daemon blobs today.
    await client.send(
      new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: encodeURIComponent(`${bucketName}/${keyPrefix}${from}`),
        Key: `${keyPrefix}${to}`,
      }),
    );
  };

  /** @type {S3BlobPowers['deleteBlob']} */
  const deleteBlob = async ({ key }) => {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: `${keyPrefix}${key}`,
      }),
    );
  };

  return harden({
    putBlobStream,
    hasBlob,
    getBlobStream,
    copyBlob,
    deleteBlob,
  });
};
