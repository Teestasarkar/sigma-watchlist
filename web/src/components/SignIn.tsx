/**
 * Sign in / create an account.
 *
 * Two things here are worth more than they look:
 *
 *  - **The password rules are checked as you type, but only shown once you
 *    have stopped.** Telling someone their password is too short while they
 *    are on the fourth character is noise; telling them after they submit is
 *    a wasted round trip.
 *  - **Login and registration are one form, not two pages.** The only thing
 *    that differs is one extra field and the verb on the button, and a
 *    separate route for each is how you end up with a "forgot which one I was
 *    on" bug.
 *
 * The demo credentials are shown deliberately. A demo account with a secret
 * password is not a demo account.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import type { AuthPolicy, User } from '../lib/types.js';

interface Props {
  onSignedIn: (user: User, isNew: boolean) => void;
}

type Mode = 'login' | 'register';

/**
 * Client-side mirror of the server's rules.
 *
 * Deliberately a *mirror*, not the authority: the server checks the same
 * things and its answer is the one that counts. This exists so the common
 * mistakes are caught without a round trip, not to be trusted.
 */
function localPasswordProblem(password: string, handle: string, min: number): string | null {
  if (password.length === 0) return null;
  if (password.length < min) return `At least ${min} characters (${password.length} so far).`;
  const lower = password.toLowerCase();
  const h = handle.trim().toLowerCase();
  if (h.length >= 2 && (lower.includes(h) || h.includes(lower))) {
    return 'Cannot be based on your username.';
  }
  if (/^(.)\1+$/.test(password)) return 'That is one character repeated.';
  if (password.length < 12 && new Set(password).size < 5) {
    return 'Use a few more different characters, or make it longer.';
  }
  return null;
}

export function SignIn({ onSignedIn }: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);
  const [touchedPassword, setTouchedPassword] = useState(false);

  const handleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    handleRef.current?.focus();
    void api.authPolicy().then(setPolicy).catch(() => undefined);
  }, []);

  const minLength = policy?.minPasswordLength ?? 8;

  const passwordProblem = useMemo(
    () => (mode === 'register' ? localPasswordProblem(password, handle, minLength) : null),
    [mode, password, handle, minLength],
  );

  const mismatch = mode === 'register' && confirm.length > 0 && confirm !== password;

  const canSubmit =
    handle.trim().length >= 2 &&
    password.length > 0 &&
    !busy &&
    (mode === 'login' || (passwordProblem === null && confirm === password));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'register'
          ? await api.register(handle.trim(), password)
          : await api.login(handle.trim(), password);
      onSignedIn(result.user, result.isNew);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // A taken username is a username problem, so send them back to it.
        if (err.code === 'conflict') handleRef.current?.focus();
      } else {
        setError('Could not reach the server. Is the API running?');
      }
      setBusy(false);
    }
  };

  const useDemo = async (): Promise<void> => {
    if (!policy?.demo) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(policy.demo.handle, policy.demo.password);
      onSignedIn(result.user, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in to the demo account.');
      setBusy(false);
    }
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setConfirm('');
    setTouchedPassword(false);
  };

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="brand" style={{ fontSize: 19, marginBottom: 20 }}>
          <span className="glyph" style={{ fontSize: 24 }}>
            σ
          </span>
          <span>Sigma</span>
        </div>

        <h1 className="signin-title">
          {mode === 'login' ? 'Welcome back.' : 'What actually changed since you looked?'}
        </h1>

        <p className="signin-lede">
          {mode === 'login'
            ? 'Your watchlist, checkpoint and thresholds are where you left them.'
            : 'A watchlist ranked by how unusual each move is for that instrument — not by percentage.'}
        </p>

        <div className="signin-tabs" role="tablist" aria-label="Sign in or create an account">
          <button
            role="tab"
            aria-selected={mode === 'login'}
            disabled={busy}
            onClick={() => switchMode('login')}
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'register'}
            disabled={busy}
            onClick={() => switchMode('register')}
          >
            Create account
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <label className="field" htmlFor="handle">
            <span>Username</span>
            <input
              id="handle"
              ref={handleRef}
              type="text"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value);
                setError(null);
              }}
              placeholder="letters, numbers, . _ -"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={40}
              disabled={busy}
              required
            />
          </label>

          <label className="field" htmlFor="password">
            <span className="field-row">
              Password
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setReveal((v) => !v)}
                tabIndex={-1}
              >
                {reveal ? 'hide' : 'show'}
              </button>
            </span>
            <input
              id="password"
              type={reveal ? 'text' : 'password'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              onBlur={() => setTouchedPassword(true)}
              placeholder={mode === 'register' ? `at least ${minLength} characters` : ''}
              // Tells a password manager whether to offer to save a new one.
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              disabled={busy}
              required
              aria-invalid={touchedPassword && passwordProblem !== null}
              aria-describedby={passwordProblem ? 'password-problem' : undefined}
            />
          </label>

          {mode === 'register' && touchedPassword && passwordProblem ? (
            <p id="password-problem" className="field-problem">
              {passwordProblem}
            </p>
          ) : null}

          {mode === 'register' ? (
            <label className="field" htmlFor="confirm">
              <span>Confirm password</span>
              <input
                id="confirm"
                type={reveal ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
                required
                aria-invalid={mismatch}
              />
              {mismatch ? <p className="field-problem">Those do not match.</p> : null}
            </label>
          ) : null}

          <div className="signin-actions">
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {busy
                ? mode === 'register'
                  ? 'Creating account…'
                  : 'Signing in…'
                : mode === 'register'
                  ? 'Create account'
                  : 'Sign in'}
            </button>

            {policy?.demo ? (
              <button className="btn" type="button" disabled={busy} onClick={() => void useDemo()}>
                Use the demo account
              </button>
            ) : null}
          </div>
        </form>

        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}

        {policy?.demo ? (
          <p className="signin-note">
            <strong>Demo account:</strong> <code>{policy.demo.handle}</code> /{' '}
            <code>{policy.demo.password}</code> — published on purpose. It exists so you can look
            around without registering, and a demo account with a secret password is not a demo
            account.
          </p>
        ) : null}

        <p className="signin-note">
          Passwords are hashed with scrypt and a per-account salt, compared in constant time, and
          never stored or logged in the clear. Sessions expire, can be revoked individually or all
          at once, and repeated failed attempts lock the account with a growing delay.
        </p>

        {mode === 'register' ? (
          <p className="signin-note">
            A new account comes with a starter watchlist and a year of seeded history, so the
            significance figures mean something from the first screen.
          </p>
        ) : null}
      </div>
    </main>
  );
}
