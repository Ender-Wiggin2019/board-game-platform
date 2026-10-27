import { lazy, Suspense } from 'react';
import { useToastStore } from '@/components/ui/toastStore';

const Toaster = lazy(() =>
  import('@/components/ui/toast').then((module) => ({
    default: module.Toaster,
  })),
);

export function DeferredToaster(): React.JSX.Element | null {
  const hasToasts = useToastStore((state) => state.toasts.length > 0);
  if (!hasToasts) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <Toaster />
    </Suspense>
  );
}
