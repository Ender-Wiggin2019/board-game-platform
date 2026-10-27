/** Resume only a same-origin application path; never accept a network URL. */
function hasUnsafePathCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      character === '\\' ||
      codePoint === 0x7f ||
      (codePoint !== undefined && codePoint <= 0x1f)
    );
  });
}

export function safeReturnTo(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    hasUnsafePathCharacters(value)
  ) {
    return;
  }

  try {
    const url = new URL(value, 'https://platform.invalid');
    if (
      url.origin !== 'https://platform.invalid' ||
      url.pathname.startsWith('/auth')
    ) {
      return;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return;
  }
}

export function returnNavigation(href: string) {
  return { href, replace: true } as const;
}
