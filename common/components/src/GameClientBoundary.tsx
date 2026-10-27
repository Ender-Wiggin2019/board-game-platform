import { Component, type ReactNode } from 'react';

export interface GameClientBoundaryProps {
  readonly children: (reportError: (error: unknown) => void) => ReactNode;
  readonly fallback: (error: unknown) => ReactNode;
}

/** Contains render failures and errors explicitly reported by game event/async handlers. */
export class GameClientBoundary extends Component<
  GameClientBoundaryProps,
  { failed: boolean; error?: unknown }
> {
  state: { failed: boolean; error?: unknown } = { failed: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  readonly reportError = (error: unknown) => {
    this.setState({ failed: true, error });
  };
  render() {
    return this.state.failed
      ? this.props.fallback(this.state.error)
      : this.props.children(this.reportError);
  }
}
