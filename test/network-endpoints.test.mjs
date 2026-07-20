import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRoomDirectoryEndpoint,
  resolveWebSocketEndpoint,
} from '../src/network/endpoints.js';

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

test('room discovery follows the configured multiplayer service', () => {
  assert.equal(
    resolveRoomDirectoryEndpoint(
      { websocket: 'wss://play-api.example.net/ws' },
      { href: 'https://guyzyskind.com/tinystrike/' }
    ),
    'https://play-api.example.net/api/rooms'
  );
  assert.equal(
    resolveRoomDirectoryEndpoint(
      { rooms: 'https://directory.example.net/public' },
      { href: 'https://guyzyskind.com/tinystrike/' }
    ),
    'https://directory.example.net/public'
  );
  assert.equal(
    resolveRoomDirectoryEndpoint(undefined, { href: 'http://127.0.0.1:8031/' }),
    'http://127.0.0.1:8031/api/rooms'
  );
});
