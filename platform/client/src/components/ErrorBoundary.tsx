import i18n from 'i18next';
import React from 'react';
import { CrashReportAction } from '@/components/CrashReportAction';
import { captureCrash, type ICrashIncident } from '@/lib/crashReporter';

interface IErrorBoundaryProps {
  children: React.ReactNode;
  onFatalError?: (error: unknown, info: React.ErrorInfo) => void;
}

interface IErrorBoundaryState {
  hasError: boolean;
  incident: ICrashIncident | null;
}

export class ErrorBoundary extends React.Component<
  IErrorBoundaryProps,
  IErrorBoundaryState
> {
  public constructor(props: IErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, incident: null };
  }

  public static getDerivedStateFromError(): IErrorBoundaryState {
    return { hasError: true, incident: null };
  }

  public componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    this.props.onFatalError?.(error, info);
    this.setState({
      incident: captureCrash(error, {
        source: 'react',
        componentStack: info.componentStack ?? undefined,
      }),
    });
  }

  public render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className='rounded-xl border border-danger-500/40 bg-surface-900/80 p-4 text-sm text-text-300'
          role='alert'
        >
          {i18n.t('client.error_boundary.fallback', {
            ns: 'platform-common',
            defaultValue: 'Something went wrong while rendering this section.',
          })}
          {this.state.incident ? (
            <CrashReportAction incident={this.state.incident} />
          ) : null}
        </div>
      );
    }

    return this.props.children;
  }
}
