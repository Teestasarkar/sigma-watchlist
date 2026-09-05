/**
 * Testing Library only registers its automatic cleanup when Vitest globals are
 * enabled. They are not, deliberately - explicit imports make it obvious where
 * `describe` and `expect` come from - so cleanup is wired up by hand here.
 *
 * Without it, every render accumulates in the same document and queries start
 * matching elements left behind by earlier tests. The failures look like
 * component bugs and are not.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
