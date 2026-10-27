import {
  attachIframeSessionBridge,
  type GameEntryRuntime,
} from '@board-game/client';
import {
  assertClientReleaseLocator,
  type ClientReleaseLocator,
  canonicalStableStringify,
  clientArtifactUrl,
  IFRAME_CLIENT_RUNTIME_ABI,
  type SessionRoute,
} from '@board-game/contracts';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface IframeGameEntryProps {
  readonly locator: ClientReleaseLocator;
  readonly route: SessionRoute;
  readonly runtime: GameEntryRuntime;
  readonly kind: 'live' | 'spectate' | 'replay' | 'end';
  readonly loading: ReactNode;
  readonly error: ReactNode;
  /** Override the handshake wait for bounded hosts and deterministic smoke checks. */
  readonly handshakeTimeoutMs?: number;
  readonly allowInsecureLocalhost?: boolean;
}

/** Different-origin sandbox: no host DOM access, top navigation, popups or service credentials. */
export function IframeGameEntry({
  locator,
  route,
  runtime,
  kind,
  loading,
  error,
  handshakeTimeoutMs = 30_000,
  allowInsecureLocalhost,
}: IframeGameEntryProps): React.JSX.Element {
  assertClientReleaseLocator(locator, allowInsecureLocalhost);
  if (
    locator.runtime.format !== 'iframe' ||
    locator.runtime.abiVersion !== IFRAME_CLIENT_RUNTIME_ABI ||
    locator.gameId !== route.gameId ||
    locator.releaseId !== route.releaseId
  )
    throw new Error('client.iframe.incompatible');
  const frame = useRef<HTMLIFrameElement>(null);
  const failRef = useRef<() => void>(() => undefined);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const source = clientArtifactUrl(locator, locator.runtime.entry);
  const targetOrigin = new URL(source).origin;
  const routeKey = canonicalStableStringify(route);
  useEffect(() => {
    if (!frame.current) return;
    setPhase('loading');
    let detach: (() => void) | undefined;
    let stopped = false;
    const timer = setTimeout(() => {
      detach?.();
      detach = undefined;
      if (!stopped) setPhase('error');
    }, handshakeTimeoutMs);
    const fail = () => {
      clearTimeout(timer);
      detach?.();
      detach = undefined;
      if (!stopped) setPhase('error');
    };
    failRef.current = fail;
    try {
      detach = attachIframeSessionBridge({
        window,
        frame: frame.current,
        origin: targetOrigin,
        route,
        runtime,
        kind,
        onReady: () => {
          clearTimeout(timer);
          if (!stopped) setPhase('ready');
        },
        onError: fail,
      });
    } catch {
      fail();
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      detach?.();
      detach = undefined;
      failRef.current = () => undefined;
    };
  }, [handshakeTimeoutMs, kind, routeKey, runtime, source, targetOrigin]);
  const src = new URL(source);
  src.searchParams.set('parentOrigin', window.location.origin);
  return (
    <div
      className='bgp-isolated-game'
      data-state={phase}
      aria-busy={phase === 'loading'}
    >
      {phase === 'loading' ? loading : phase === 'error' ? error : null}
      <iframe
        ref={frame}
        title={`${locator.gameId} ${kind}`}
        sandbox='allow-scripts allow-same-origin'
        referrerPolicy='no-referrer'
        className='bgp-isolated-game__frame'
        hidden={phase === 'error'}
        src={phase === 'error' ? 'about:blank' : src.href}
        onError={() => failRef.current()}
      />
    </div>
  );
}
