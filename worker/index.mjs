import { LeaderboardDurableObject } from './leaderboard-do.mjs';
import { RoomDurableObject } from './room-do.mjs';

export { LeaderboardDurableObject, RoomDurableObject };

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function allowedOrigins(env, requestUrl = '') {
  const configured = String(env.ALLOWED_ORIGINS || 'https://guyzyskind.com')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const origins = new Set();
  for (const entry of configured) {
    const origin = normalizedOrigin(entry);
    if (!origin || entry === '*') throw new Error(`Invalid exact allowed origin: ${entry}`);
    origins.add(origin);
  }
  const serviceOrigin = normalizedOrigin(requestUrl);
  if (serviceOrigin) origins.add(serviceOrigin);
  return origins;
}

function corsFor(request, env) {
  const supplied = request.headers.get('Origin');
  if (!supplied) return {};
  const origin = normalizedOrigin(supplied);
  if (!origin || !allowedOrigins(env, request.url).has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function bearerToken(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function leaderboard(env) {
  return env.LEADERBOARD.getByName('global-v1');
}

function rooms(env) {
  // The browser sends its create/join/reconnect room in the first WebSocket
  // message, after the upgrade. A single durable hub preserves that protocol
  // while keeping all room state strongly consistent and hibernatable.
  return env.ROOMS.getByName('room-hub-v1');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isWebSocket = url.pathname === '/ws';

    if (isApi || isWebSocket || url.pathname === '/health') {
      const cors = corsFor(request, env);
      if (cors === null) return jsonResponse(403, { error: 'Origin is not allowed.' });
      if (request.method === 'OPTIONS') {
        return isApi
          ? new Response(null, { status: 204, headers: cors })
          : jsonResponse(405, { error: 'Method not allowed.' }, { Allow: 'GET' });
      }

      if (url.pathname === '/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return jsonResponse(405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        }
        const health = await leaderboard(env).fetch('https://internal/internal/health');
        const storage = health.ok ? await health.json() : { ok: false };
        const response = jsonResponse(health.ok ? 200 : 503, {
          ok: health.ok,
          service: 'tiny-strike',
          leaderboard: storage,
          multiplayer: 'ready',
        }, cors);
        return request.method === 'HEAD'
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      }

      if (isWebSocket) {
        if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return jsonResponse(426, { error: 'Expected a WebSocket upgrade.' }, {
            ...cors,
            Upgrade: 'websocket',
          });
        }
        return rooms(env).fetch(request);
      }

      if (url.pathname === '/api/rooms') {
        if (request.method !== 'GET') {
          return jsonResponse(405, { error: 'Method not allowed.' }, {
            ...cors,
            Allow: 'GET, OPTIONS',
          });
        }
        const response = await rooms(env).fetch('https://internal/internal/rooms');
        return withHeaders(response, cors);
      }

      if (url.pathname === '/api/admin/import') {
        if (request.method !== 'POST') {
          return jsonResponse(405, { error: 'Method not allowed.' }, { ...cors, Allow: 'POST' });
        }
        if (!env.ADMIN_TOKEN) {
          return jsonResponse(503, { error: 'Leaderboard import is not configured.' }, cors);
        }
        if (!constantTimeEqual(bearerToken(request), env.ADMIN_TOKEN)) {
          return jsonResponse(401, { error: 'A valid admin token is required.' }, cors);
        }
        const internalRequest = new Request('https://internal/internal/import', {
          method: 'POST',
          headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
          body: request.body,
        });
        return withHeaders(await leaderboard(env).fetch(internalRequest), cors);
      }

      if (url.pathname === '/api/leaderboard' || url.pathname.startsWith('/api/leaderboard/')) {
        return withHeaders(await leaderboard(env).fetch(request), cors);
      }
      return jsonResponse(404, { error: 'Not found.' }, cors);
    }

    return jsonResponse(404, { error: 'Not found.' });
  },
};
