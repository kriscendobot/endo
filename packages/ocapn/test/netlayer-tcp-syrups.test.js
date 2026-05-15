// @ts-check

import net from 'net';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { test } from './_util.js';
import { makeClient } from '../src/client/index.js';
import { makeTcpNetLayer } from '../src/netlayers/tcp-test-only.js';
import { encodeSwissnum } from '../src/client/util.js';

const COMMA = ','.charCodeAt(0);
const COLON = ':'.charCodeAt(0);
const ZERO = '0'.charCodeAt(0);
const NINE = '9'.charCodeAt(0);

/**
 * Establishes a TCP server that captures the first chunk of bytes
 * received from any connection, then closes the connection. Used to
 * peek at the wire format of an outgoing handshake from the JS
 * netlayer.
 *
 * @returns {Promise<{
 *   port: number,
 *   address: string,
 *   firstBytes: Promise<Uint8Array>,
 *   close: () => void,
 * }>}
 */
const makeSnifferServer = async () => {
  /** @type {(bytes: Uint8Array) => void} */
  let resolveBytes;
  const firstBytes = new Promise(resolve => {
    resolveBytes = resolve;
  });
  const server = net.createServer(socket => {
    socket.once('data', data => {
      resolveBytes(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      socket.destroy();
    });
  });
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', err =>
        err ? reject(err) : resolve(undefined),
      );
    })
  );
  const addressInfo = server.address();
  if (typeof addressInfo !== 'object' || addressInfo === null) {
    throw Error('Unexpected server address');
  }
  return {
    port: addressInfo.port,
    address: addressInfo.address,
    firstBytes,
    close: () => server.close(),
  };
};

test('syrups framing wraps outgoing bytes with <length>:<payload> and contains no comma', async t => {
  const sniffer = await makeSnifferServer();
  t.teardown(() => sniffer.close());

  const client = makeClient({ debugLabel: 'syrups-sniff', debugMode: true });
  t.teardown(() => client.shutdown());

  const netlayer = await client.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'sniff-A',
      framing: 'syrups',
    }),
  );

  // Trigger an outbound handshake to the sniffer. The sniffer
  // closes the connection immediately, so the pending session
  // rejects; swallow it so it does not surface as an unhandled
  // rejection.
  client
    .provideSession({
      type: 'ocapn-peer',
      transport: netlayer.location.transport,
      designator: 'sniff-B',
      hints: { host: sniffer.address, port: String(sniffer.port) },
    })
    .catch(() => {});

  const bytes = await sniffer.firstBytes;

  // The first bytes on the wire must be ASCII digits forming the
  // syrups length prefix.
  t.true(bytes.length > 2, 'sniffer captured at least 3 bytes');
  t.true(
    bytes[0] >= ZERO && bytes[0] <= NINE,
    `first byte is an ASCII digit (got ${bytes[0]})`,
  );

  // The first ':' separates the length prefix from the payload; all
  // bytes before it must be ASCII digits. Crucially, no comma
  // appears in or before that prefix: a netstring frame for a
  // payload of N bytes would be `<digits>:<payload>,` with the comma
  // sitting at index `1 + ceil(log10(N+1)) + N`, but a syrups frame
  // omits that trailing separator. Decode the prefix and confirm
  // there is no comma at the netstring-terminator position.
  const colonIndex = bytes.indexOf(COLON);
  t.true(colonIndex > 0, 'a ":" separator follows the length prefix');
  for (let i = 0; i < colonIndex; i += 1) {
    t.true(
      bytes[i] >= ZERO && bytes[i] <= NINE,
      `prefix byte at index ${i} is an ASCII digit`,
    );
  }
  const declaredPayloadLength = Number(
    String.fromCharCode(...bytes.subarray(0, colonIndex)),
  );
  const netstringTerminatorIndex = colonIndex + 1 + declaredPayloadLength;
  // The captured chunk must contain at least the framed handshake.
  t.true(
    bytes.length >= netstringTerminatorIndex,
    `captured ${bytes.length} bytes covers the framed payload (${netstringTerminatorIndex})`,
  );
  // If there are any bytes past the payload, none of them is a
  // netstring `,` separator at the position a netstring writer
  // would have placed it.
  if (bytes.length > netstringTerminatorIndex) {
    t.not(
      bytes[netstringTerminatorIndex],
      COMMA,
      'no trailing "," at the position a netstring writer would emit one',
    );
  } else {
    t.pass(
      'captured chunk ends exactly at the framed payload, with no trailing separator',
    );
  }
});

test('syrups framing round-trip through the test-only TCP netlayer', async t => {
  const swissnumTable = new Map();
  swissnumTable.set(
    'Echo',
    Far('echo', {
      echo: value => value,
    }),
  );

  const clientA = makeClient({
    debugLabel: 'syrups-A',
    debugMode: true,
  });
  const clientB = makeClient({
    debugLabel: 'syrups-B',
    debugMode: true,
    swissnumTable,
  });
  t.teardown(() => {
    clientA.shutdown();
    clientB.shutdown();
  });

  await clientA.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'syrups-A',
      framing: 'syrups',
    }),
  );
  const netlayerB = await clientB.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'syrups-B',
      framing: 'syrups',
    }),
  );

  const session = await clientA.provideSession(netlayerB.location);
  const bootstrap = session.getBootstrap();
  const echoRef = await E(bootstrap).fetch(encodeSwissnum('Echo'));
  const result = await E(echoRef).echo('hello syrups');
  t.is(result, 'hello syrups');
});

test('rejects unknown framing option', async t => {
  await t.throwsAsync(
    () =>
      makeTcpNetLayer({
        framing: /** @type {'syrups'} */ (/** @type {unknown} */ ('bogus')),
        handlers: /** @type {any} */ ({}),
        logger: /** @type {any} */ ({
          log: () => {},
          error: () => {},
          info: () => {},
        }),
      }),
    { message: /Unsupported framing/ },
  );
});
