import { ChevronRight } from 'lucide-react';
import type { DetailsHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import './disclosure.css';

export function Disclosure({
  summary,
  summaryClassName,
  className,
  children,
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement> & {
  summary: ReactNode;
  summaryClassName?: string;
}): React.JSX.Element {
  return (
    <details className={cn('ui-disclosure', className)} {...props}>
      <summary className={summaryClassName}>
        <ChevronRight
          size={16}
          aria-hidden
          className='ui-disclosure__chevron'
        />
        {summary}
      </summary>
      {children}
    </details>
  );
}
