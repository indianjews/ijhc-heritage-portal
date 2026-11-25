import { vi } from 'vitest';

/*
 * Why contributor-edit-render.test.tsx failed about one full run in three.
 *
 * After a save the form unmounts and focus falls to <body>; the component then
 * moved it back to "Edit" in a useEffect. React's scheduler normally runs that
 * passive effect in the same task as the commit — unless the commit used up
 * its 5 ms slice, in which case it yields and runs the effect in a later
 * `setImmediate`. Testing Library resolves `findBy*` from a DOM-mutation
 * microtask and drains with a `setTimeout`, so on a loaded machine the
 * assertion could run before the effect: focus still on <body>.
 *
 * Both halves of that are forced here, every time: the scheduler's
 * setImmediate is delayed (React is loaded fresh after the stub, because the
 * scheduler captures it at import), and the clock jumps so the slice is always
 * exhausted. Focus moved inside the commit (useLayoutEffect) passes anyway;
 * focus moved in a passive effect does not.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// tests/setup.ts has already loaded React with the real setImmediate, so start
// from a fresh module registry and load React again after the delay is in place.
vi.resetModules();
const realSetImmediate = globalThis.setImmediate;
(globalThis as { setImmediate: unknown }).setImmediate =
  (callback: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(() => callback(...args), 200);
const { fireEvent, render, screen } = await import('@testing-library/react');
const { en } = await import('@/lib/i18n/messages');
const { MessagesProvider } = await import('@/lib/i18n/provider');
const { ContributorEditForm } = await import('@/components/contributor-edit');
globalThis.setImmediate = realSetImmediate;
const { expect, it } = await import('vitest');

it('returns focus to the Edit button as soon as the save is shown, however late the scheduler runs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  render(<MessagesProvider catalogue={en}><ContributorEditForm itemId="one" token="signed" title="Family" description="" /></MessagesProvider>);
  fireEvent.click(screen.getByRole('button', { name: en['receipt.editAction'] }));
  expect(screen.getByLabelText(en['receipt.editTitle'])).toHaveFocus();
  // A busy machine: every clock reading is 50 ms later, so React's scheduler
  // exhausts its 5 ms slice after the commit and yields before running passive
  // effects. That is the state the flaky full-suite runs were in.
  const now = performance.now.bind(performance);
  let skew = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + (skew += 50));
  fireEvent.click(screen.getByRole('button', { name: en['receipt.editSave'] }));
  await screen.findByText(en['receipt.editSaved']);
  clock.mockRestore();
  // No waitFor: the moment "Saved" is on screen, focus must already be back.
  expect(screen.getByRole('button', { name: en['receipt.editAction'] })).toHaveFocus();
});
