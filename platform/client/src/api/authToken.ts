export const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 60_000;

/** The unverified expiry is used only to schedule renewal, never to grant access. */
export function getAccessTokenExpiresAt(
  token: string | null,
): number | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const { exp } = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    );
    return typeof exp === 'number' && Number.isFinite(exp)
      ? exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

export function isAccessTokenExpiring(token: string | null): boolean {
  const expiresAt = getAccessTokenExpiresAt(token);
  return (
    expiresAt !== undefined &&
    expiresAt - Date.now() <= ACCESS_TOKEN_REFRESH_LEEWAY_MS
  );
}
