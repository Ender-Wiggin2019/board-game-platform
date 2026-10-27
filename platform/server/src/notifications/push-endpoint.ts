const MAX_ENDPOINT_LENGTH = 2_048;

const EXACT_PUSH_SERVICE_HOSTS = new Set([
  // Chromium / Firebase Cloud Messaging (including legacy GCM endpoints).
  'android.googleapis.com',
  'fcm.googleapis.com',
  // Safari / iOS Home Screen web apps.
  'web.push.apple.com',
]);

const PUSH_SERVICE_HOST_SUFFIXES = [
  // Apple documents Web Push delivery on arbitrary subdomains of this parent.
  '.push.apple.com',
  // Firefox push endpoints. The concrete subdomain may change.
  '.push.services.mozilla.com',
  // Microsoft explicitly requires validating the WNS parent domain rather
  // than a concrete, changeable subdomain.
  '.notify.windows.com',
];

function isAllowedPushServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    EXACT_PUSH_SERVICE_HOSTS.has(host) ||
    host === 'push.services.mozilla.com' ||
    host === 'notify.windows.com' ||
    PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/**
 * Browser subscriptions are bearer-like callback URLs. Accept only the push
 * service origins this application supports; otherwise a PLAYER could turn
 * push delivery into an arbitrary server-side HTTPS request.
 */
export function isAllowedPushEndpoint(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_LENGTH ||
    /\s/.test(value)
  ) {
    return false;
  }

  try {
    const endpoint = new URL(value);
    return (
      endpoint.href === value &&
      endpoint.protocol === 'https:' &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.port === '' &&
      endpoint.hash === '' &&
      isAllowedPushServiceHost(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

export { MAX_ENDPOINT_LENGTH };
