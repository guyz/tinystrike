import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWebSocketEndpoint } from '../src/network/endpoints.js';

test('WebSocket endpoint follows the page by default and supports a split production origin', () => {
  assert.equal(
    resolveWebSocketEndpoint(undefined, { href: 'https://guyzyskind.com/tinystrike/' }),
    'wss://guyzyskind.com/ws'
  );
  assert.equal(
    resolveWebSocketEndpoint(
      { websocket: 'https://play-api.example.net/ws' },
      { href: 'https://guyzyskind.com/tinystrike/' }
    ),
    'wss://play-api.example.net/ws'
  );
  assert.equal(
    resolveWebSocketEndpoint(
      { ws: '/rooms' },
      { href: 'http://127.0.0.1:8031/tinystrike/' }
    ),
    'ws://127.0.0.1:8031/rooms'
  );
});

test('WebSocket endpoint rejects non-WebSocket-capable protocols', () => {
  assert.throws(
    () => resolveWebSocketEndpoint(
      { websocket: 'ftp://example.net/ws' },
      { href: 'https://guyzyskind.com/tinystrike/' }
    ),
    /must use ws, wss, http, or https/
  );
});
