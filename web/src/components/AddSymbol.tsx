/**
 * The add-symbol control.
 *
 * A debounced search with an abortable request and keyboard navigation.
 * Aborting matters more than it looks: typing "NVDA" fires four searches, and
 * without cancellation the response for "NV" can land after the one for
 * "NVDA" and replace the correct results with stale ones. That out-of-order
 * bug is invisible on a fast connection and constant on a slow one.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';

interface Result {
  symbol: string;
  name: string;
  sector: string | null;
}

interface Props {
  onAdd: (symbol: string) => Promise<void>;
  disabled?: boolean;
}

export function AddSymbol({ onAdd, disabled }: Props): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced, abortable search.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .search(term, controller.signal)
        .then((res) => {
          setResults(res.results);
          setOpen(res.results.length > 0);
          setActive(0);
        })
        .catch((err: unknown) => {
          // An aborted request is the expected outcome of typing, not an error.
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setResults([]);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Dismiss on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const submit = async (symbol: string): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onAdd(symbol.toUpperCase());
      setQuery('');
      setResults([]);
      setOpen(false);
    } catch (err) {
      // Surface the API's own message: "no market data available for ZZZQQ" is
      // far more useful than a generic failure toast.
      setError(err instanceof ApiError ? err.message : 'could not add that symbol');
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = open && results[active] ? (results[active] as Result).symbol : query.trim();
      if (chosen) void submit(chosen);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="add-wrap" ref={wrapRef}>
      <div style={{ display: 'flex', gap: 7 }}>
        <input
          type="text"
          value={query}
          placeholder="Add a symbol…"
          aria-label="Add a symbol to this watchlist"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || pending}
          onChange={(e) => {
            setQuery(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(results.length > 0)}
          style={{ width: 190 }}
        />
        <button
          className="btn btn-sm"
          disabled={disabled || pending || query.trim() === ''}
          onClick={() => void submit(query.trim())}
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {error ? (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--down)' }} role="alert">
          {error}
        </div>
      ) : null}

      {open ? (
        <div className="add-results" role="listbox">
          {results.map((r, i) => (
            <button
              key={r.symbol}
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => void submit(r.symbol)}
            >
              <span className="sym">{r.symbol}</span>
              <span className="nm">{r.name}</span>
              {r.sector ? (
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-4)' }}>
                  {r.sector}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
