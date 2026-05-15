---
'@endo/ocapn': minor
---

- Add an opt-in `framing` option to `makeTcpNetLayer` (`@endo/ocapn/netlayer/tcp-testing`). The default is `'none'`, preserving the current wire format used by the `ocapn/ocapn-test-suite` Python `testing_only_tcp` netlayer (raw syrup-encoded messages with no length prefix). Passing `framing: 'syrups'` wraps each message in the `<length>:<payload>` framing implemented by `@endo/syrup-frame`, which makes the transport robust to TCP chunk boundaries that split a single OCapN message and lets two peers that both opt in share a single length-prefixed primitive with the syrup payload format itself.
