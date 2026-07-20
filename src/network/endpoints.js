function locationBase(locationLike) {
  if (locationLike && locationLike.href) return locationLike.href;
  const protocol = locationLike?.protocol || 'http:';
  const host = locationLike?.host || 'localhost';
  return `${protocol}//${host}/`;
}

/** Resolve the room WebSocket independently from the static game's origin. */
export function resolveWebSocketEndpoint(
  config = globalThis.TINY_STRIKE_API,
  locationLike = globalThis.location
) {
  const configured = config && (config.websocket || config.ws);
  const url = new URL(configured || '/ws', locationBase(locationLike));
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TypeError('Tiny Strike WebSocket endpoint must use ws, wss, http, or https.');
  }
  return url.toString();
}

/** Resolve the public room browser next to the configured multiplayer service. */
export function resolveRoomDirectoryEndpoint(
  config = globalThis.TINY_STRIKE_API,
  locationLike = globalThis.location
) {
  const explicit = config && (config.rooms || config.roomDirectory || config.roomDiscovery);
  if (explicit) {
    const url = new URL(explicit, locationBase(locationLike));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('Tiny Strike room directory endpoint must use http or https.');
    }
    return url.toString();
  }

  const serviceHint = config && (config.websocket || config.ws || config.leaderboard);
  if (serviceHint) {
    const url = new URL(serviceHint, locationBase(locationLike));
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('Tiny Strike room service endpoint must use http, https, ws, or wss.');
    }
    url.pathname = '/api/rooms';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  return new URL('/api/rooms', locationBase(locationLike)).toString();
}
