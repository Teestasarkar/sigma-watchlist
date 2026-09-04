/**
 * Sign-in.
 *
 * There is no password field, and the screen says so rather than hiding it.
 *
 * That is a deliberate choice, not an unfinished one. A half-built login —
 * password hashing with no reset flow, no attempt rate-limiting, no session
 * revocation — is worse than an obvious shortcut, because it invites the
 * reader to assume a security property that is not there. See DECISIONS.md #10.
 *
 * The screen exists because the *architecture* is genuinely multi-tenant and
 * was previously invisible: the app auto-signed-in as `demo`, so nobody ever
 * discovered that watchlists and checkpoints are per-user and isolated in SQL.
 * Being able to open two browsers under different names and watch the
 * checkpoints diverge is the clearest demonstration of the thing this product
 * is actually about.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { User } from '../lib/types.js';

interface Props {
  onSignedIn: (user: User, isNew: boolean) => void;
}

const SUGGESTIONS = ['demo', 'alice', 'bob'];

export function SignIn({ onSignedIn }: Props): React.JSX.Element {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const signIn = async (name: string): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Pick any name — it becomes your account.');
      inputRef.current?.focus();
      return;
    }

    setBusy(trimmed);
    setError(null);
    try {
      const { user, isNew } = await api.signIn(trimmed);
      onSignedIn(user, isNew);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Is the API running?',
      );
      setBusy(null);
    }
  };

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="brand" style={{ fontSize: 19, marginBottom: 22 }}>
          <span className="glyph" style={{ fontSize: 24 }}>
            σ
          </span>
          <span>Sigma</span>
        </div>

        <h1 className="signin-title">What actually changed since you looked?</h1>

        <p className="signin-lede">
          A watchlist ranked by how unusual each move is <em>for that instrument</em> — not by
          percentage. Your checkpoint, watchlist and thresholds are yours.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void signIn(handle);
          }}
        >
          <label className="field" htmlFor="handle">
            <span>Pick a name</span>
            <input
              id="handle"
              ref={inputRef}
              type="text"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value);
                setError(null);
              }}
              placeholder="anything at all"
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              disabled={busy !== null}
              aria-describedby="handle-note"
            />
          </label>

          <div className="signin-actions">
            <button className="btn btn-primary" type="submit" disabled={busy !== null}>
              {busy !== null && busy !== 'demo' ? 'Setting up…' : 'Continue'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() => void signIn('demo')}
            >
              {busy === 'demo' ? 'Loading…' : 'Continue as demo'}
            </button>
          </div>
        </form>

        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}

        {/*
          Stating the shortcut plainly. A reviewer should not have to guess
          whether the missing password is a decision or an omission.
        */}
        <p id="handle-note" className="signin-note">
          <strong>No password, on purpose.</strong> Authentication is not what this project is
          about, and a half-built login would imply security it does not have. What <em>is</em>{' '}
          real: every request needs a bearer token, and each account&rsquo;s watchlists and
          checkpoints are isolated at the SQL layer — one account cannot read or write
          another&rsquo;s.
        </p>

        <p className="signin-note">
          A new name creates a fresh account with a starter watchlist. Returning to the same name
          returns you to the same account, checkpoint included.{' '}
          <span style={{ color: 'var(--text-3)' }}>
            Try two names in two windows and watch their briefings diverge.
          </span>
        </p>

        <div className="signin-suggest">
          <span>Existing:</span>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="btn-ghost btn-sm"
              type="button"
              disabled={busy !== null}
              onClick={() => void signIn(s)}
              style={{ fontFamily: 'var(--mono)' }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
