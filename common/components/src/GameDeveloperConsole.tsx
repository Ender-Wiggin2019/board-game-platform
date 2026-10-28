import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { GamePortal } from './GamePortal.js';

export type GameDeveloperConsoleTone = 'input' | 'output' | 'error' | 'info';

export interface GameDeveloperConsoleLine {
  readonly id: string | number;
  readonly text: string;
  readonly tone: GameDeveloperConsoleTone;
}

export interface GameDeveloperConsolePreset {
  readonly label: string;
  readonly command: string;
}

export type GameDeveloperConsoleSubmitResult =
  | void
  | boolean
  | Promise<void | boolean>;

export interface GameDeveloperConsoleProps {
  /** The current, already formatted display log. The console never mutates it. */
  readonly lines: readonly GameDeveloperConsoleLine[];
  /** Submitted commands in oldest-to-newest order for arrow-key recall. */
  readonly history?: readonly string[];
  /** Called with the trimmed command. Return false or reject to retain input. */
  readonly onSubmit: (command: string) => GameDeveloperConsoleSubmitResult;
  readonly onClose?: () => void;
  readonly presets?: readonly GameDeveloperConsolePreset[];
  /** Accessible/localized heading for the preset command group. */
  readonly presetsLabel?: string;
  readonly busy?: boolean;
  /** Embedded panels stay in normal flow and do not close on Escape. */
  readonly embedded?: boolean;
  readonly title?: ReactNode;
  readonly targetSummary?: ReactNode;
  readonly placeholder?: string;
  readonly closeLabel?: string;
}

const TONE_CLASS: Record<GameDeveloperConsoleTone, string> = {
  input: 'bgp-game-developer-console__line--input',
  output: 'bgp-game-developer-console__line--output',
  error: 'bgp-game-developer-console__line--error',
  info: 'bgp-game-developer-console__line--info',
};

function isPromiseLike(
  value: GameDeveloperConsoleSubmitResult,
): value is Promise<void | boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Shared developer-console shell. Games own access checks, command parsing,
 * logs and command history; this component owns only the bounded UI and input
 * interaction. A rejected submission leaves its raw input available to retry.
 */
export function GameDeveloperConsole({
  lines,
  history = [],
  onSubmit,
  onClose,
  presets = [],
  presetsLabel = 'Common commands',
  busy = false,
  embedded = false,
  title = 'Developer Console',
  targetSummary,
  placeholder = 'type a command, or "help"',
  closeLabel = 'Close console',
}: GameDeveloperConsoleProps): React.JSX.Element {
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef('');
  const pendingRef = useRef(false);

  const busyState = busy || pending;
  inputValueRef.current = input;

  useEffect(() => {
    if (typeof scrollRef.current?.scrollTo === 'function') {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [lines]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const finishSubmission = useCallback(
    (submittedInput: string, accepted: boolean): void => {
      pendingRef.current = false;
      setPending(false);
      if (accepted && inputValueRef.current === submittedInput) {
        setInput('');
      }
    },
    [],
  );

  const submit = useCallback((): void => {
    if (busyState || pendingRef.current) return;
    const submittedInput = input;
    const command = submittedInput.trim();
    if (!command) return;

    pendingRef.current = true;
    setPending(true);
    setHistoryIndex(null);

    let result: GameDeveloperConsoleSubmitResult;
    try {
      result = onSubmit(command);
    } catch {
      finishSubmission(submittedInput, false);
      return;
    }

    if (isPromiseLike(result)) {
      void result
        .then((accepted) =>
          finishSubmission(submittedInput, accepted !== false),
        )
        .catch(() => finishSubmission(submittedInput, false));
      return;
    }

    finishSubmission(submittedInput, result !== false);
  }, [busyState, finishSubmission, input, onSubmit]);

  const onInputKey = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === 'Escape') {
        if (embedded || !onClose) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (history.length === 0) return;
        const index =
          historyIndex === null
            ? history.length - 1
            : Math.max(0, historyIndex - 1);
        setHistoryIndex(index);
        setInput(history[index]);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyIndex === null) return;
        const index = historyIndex + 1;
        if (index >= history.length) {
          setHistoryIndex(null);
          setInput('');
        } else {
          setHistoryIndex(index);
          setInput(history[index]);
        }
      }
    },
    [embedded, history, historyIndex, onClose, submit],
  );

  const panel = (
    <div
      className='bgp-game-developer-console'
      data-embedded={embedded || undefined}
      data-state={busyState ? 'busy' : 'ready'}
      aria-busy={busyState}
      data-testid='dev-console'
    >
      <div className='bgp-game-developer-console__header'>
        <span className='bgp-game-developer-console__title'>{title}</span>
        {targetSummary != null && (
          <span className='bgp-game-developer-console__target'>
            {targetSummary}
          </span>
        )}
        {onClose != null && (
          <button
            type='button'
            aria-label={closeLabel}
            onClick={onClose}
            className='bgp-game-developer-console__close'
            hidden={embedded}
          >
            ✕
          </button>
        )}
      </div>

      <div ref={scrollRef} className='bgp-game-developer-console__log'>
        {lines.map((line) => (
          <div
            key={line.id}
            className={`bgp-game-developer-console__line ${TONE_CLASS[line.tone]}`}
          >
            {line.text}
          </div>
        ))}
      </div>

      {presets.length > 0 && (
        <div
          aria-label={presetsLabel}
          className='bgp-game-developer-console__presets'
          data-testid='dev-console-presets'
          role='group'
        >
          <span className='bgp-game-developer-console__preset-label'>
            {presetsLabel}
          </span>
          {presets.map((preset) => (
            <button
              key={preset.command}
              type='button'
              aria-label={`${preset.label}: ${preset.command}`}
              disabled={busyState}
              onClick={() => {
                setInput(preset.command);
                setHistoryIndex(null);
                inputRef.current?.focus();
              }}
              className='bgp-game-developer-console__preset'
            >
              <span>{preset.label}</span>
              <code>{preset.command}</code>
            </button>
          ))}
        </div>
      )}

      <div className='bgp-game-developer-console__input-row'>
        <span className='bgp-game-developer-console__prompt'>›</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onInputKey}
          spellCheck={false}
          autoComplete='off'
          placeholder={placeholder}
          className='bgp-game-developer-console__input'
          data-testid='dev-console-input'
        />
      </div>
    </div>
  );

  return embedded ? panel : <GamePortal>{panel}</GamePortal>;
}
