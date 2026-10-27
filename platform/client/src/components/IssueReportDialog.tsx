import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Label } from './ui/label.js';
import { toast } from './ui/toast.js';

export interface IssueReportDraft {
  readonly description: string;
  readonly category: string;
  readonly expectedBehavior?: string;
}

/** One report form shared by game diagnostics and selected session events. */
export function IssueReportDialog({
  categories,
  ai = false,
  attachment,
  onSubmit,
  onClose,
}: {
  readonly categories: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly ai?: boolean;
  readonly attachment?: ReactNode;
  readonly onSubmit: (
    draft: IssueReportDraft,
  ) => Promise<{ readonly id: string }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('common');
  const id = useId();
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(categories[0]?.value ?? '');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = (): void => {
    if (!pending.current) onClose();
  };
  const submit = async (): Promise<void> => {
    if (pending.current || !description.trim()) return;
    pending.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onSubmit({
        description: description.trim(),
        category,
        ...(ai && expectedBehavior.trim()
          ? { expectedBehavior: expectedBehavior.trim() }
          : {}),
      });
      if (!mounted.current) return;
      toast({
        title: t('client.logReport.success'),
        description: t('client.logReport.reference', { id: result.id }),
        variant: 'success',
      });
      onClose();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      dismissible={!submitting}
      ariaLabel={t(ai ? 'client.logReport.aiTitle' : 'client.logReport.title')}
    >
      <DialogContent
        onClose={submitting ? undefined : close}
        closeLabel={t('client.logReport.cancel')}
      >
        <DialogHeader>
          <DialogTitle>
            {t(ai ? 'client.logReport.aiTitle' : 'client.logReport.title')}
          </DialogTitle>
          <DialogDescription>
            {t('client.logReport.description')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3 py-3'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={`${id}-description`}>
              {t(
                ai
                  ? 'client.logReport.aiDescription'
                  : 'client.logReport.whatHappened',
              )}
            </Label>
            <textarea
              id={`${id}-description`}
              data-dialog-initial-focus
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              maxLength={5000}
              disabled={submitting}
              className='w-full resize-y rounded-md bg-surface-900 p-3 text-sm text-text-100'
            />
          </div>
          {ai ? (
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={`${id}-expected`}>
                {t('client.logReport.expected')}
              </Label>
              <textarea
                id={`${id}-expected`}
                value={expectedBehavior}
                onChange={(event) => setExpectedBehavior(event.target.value)}
                rows={3}
                maxLength={5000}
                disabled={submitting}
                className='w-full resize-y rounded-md bg-surface-900 p-3 text-sm text-text-100'
              />
            </div>
          ) : null}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={`${id}-category`}>
              {t('client.logReport.category')}
            </Label>
            <select
              id={`${id}-category`}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={submitting}
              className='min-h-10 w-full rounded-md bg-surface-900 px-3 text-sm text-text-100'
            >
              {categories.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {attachment ? (
            <div className='rounded-md bg-surface-900/60 p-3 text-xs text-text-400'>
              {attachment}
            </div>
          ) : null}
          {error ? (
            <p role='alert' className='text-sm text-red-400'>
              {t('client.logReport.failure')} {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={close} disabled={submitting}>
            {t('client.logReport.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || !description.trim()}
          >
            {t(
              submitting
                ? 'client.logReport.submitting'
                : 'client.logReport.submit',
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
