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
