/**
 * Whether this launch delivers task completions through the native Windows
 * toast - the process-level fact the terminal title and the toast branch have
 * to agree on (R5) - the profile document that answer is read against, and how
 * many toasts were shown, which is what makes the title due for a rewrite after
 * one of them reset it from outside (UAT-M4).
 *
 * The host resolves the notification settings once, where it configures them,
 * and publishes the answer here, because the renderer that writes the title
 * cannot see them. Module-level state, like `terminal-focus-state.ts` beside it:
 * one process, one answer, and a live `/settings` edit moves both sides at once.
 *
 * Subscribable for the same reason: the host publishes wherever it configures
 * the settings, which can be after the title was first written - and a title that
 * never changes again would never be rewritten (T-FIX-04). The transport publishes
 * the second fact here for the same kind of reason: a toast it showed can reset
 * the title from outside the renderer, which no render would ever notice (UAT-M4).
 */
import { join } from 'node:path'
import { resolveDshProfileName } from '../update.js'
import { dshHomeDir } from '../utils/credentials.js'

let wired = false
let toastsShown = 0
const subscribers: Set<() => void> = new Set()

/**
 * Publish whether this launch routes task completions to the native toast.
 * Watchers are notified only when the answer moves: each notification rewrites
 * the terminal title, so re-publishing the answer a live `/settings` edit did not
 * change would be work with nothing behind it.
 * @param value - true while the toast branch is the one that will deliver.
 */
export function setWindowsToastWiring(value: boolean): void {
  if (wired === value) return
  wired = value
  for (const cb of subscribers) {
    cb()
  }
}

/**
 * Whether a task completion from this process can be delivered as a native
 * toast - the condition under which the title's marker promises a click that
 * comes back. A process that never published an answer has no toast to promise,
 * so this reads false until the host says otherwise.
 * @returns true while this launch routes task completions to the toast.
 */
export function windowsToastWired(): boolean {
  return wired
}

/**
 * Subscribe to wiring changes, for useSyncExternalStore. The title hook needs
 * them: it writes the marker from the renderer, and the host's answer may only
 * arrive after the title that carries it was already written.
 * @param cb - callback invoked synchronously when the answer moves.
 * @returns a function that unsubscribes the callback.
 */
export function subscribeWindowsToastWiring(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Note that a toast was shown from this process, which puts the terminal title
 * back in the renderer's hands.
 *
 * Showing one runs a PowerShell host of its own, and such a host sets the console
 * title as it starts: a child that reaches this console renames the session's tab
 * and takes the `[dsh-tui:<pid>]` marker with it, so a click on the toast finds
 * no tab (UAT-M4 - measured, the tab read `Windows PowerShell` right after a
 * toast went out). The title is written by the renderer, which cannot see the
 * transport, so the transport says so here. The spawn itself is kept off this
 * console (`terminal-notification-windows.ts`) and this is the second half: a
 * title that was reset anyway is written again.
 */
export function noteWindowsToastShown(): void {
  toastsShown += 1
  for (const cb of subscribers) {
    cb()
  }
}

/**
 * How many toasts this process has shown - the value the title hook keys its
 * rewrite on. A count and not a flag: a second toast is a second reset, and an
 * unchanged answer would leave the tab as the first rewrite left it.
 * @returns The number of toasts shown so far.
 */
export function windowsToastShownVersion(): number {
  return toastsShown
}

/**
 * Subscribe to "a toast was shown", for useSyncExternalStore. The same subscriber
 * set as the wiring above, told apart by the snapshot each caller reads: one
 * module, one notification channel, and a hook that re-reads only what moved.
 * @param cb - callback invoked synchronously when a toast is shown.
 * @returns a function that unsubscribes the callback.
 */
export function subscribeWindowsToastShown(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * `<dshHome>/profiles/<profile>/package.json` - the document that says whether an
 * external notifier already owns task completions, which is what stands both the
 * toast and the title's marker down (D8).
 *
 * Resolved here, beside the wiring, because the two halves of the promise have to
 * read the same document: the host resolves it again at delivery time
 * (`taskCompletionProfileDocument` in `src/dsh-adapter/plugin.ts`), and a pair
 * that disagreed would deliver a toast whose click lands on an unmarked title. The
 * regression pins the two answers to each other on both launch routes; naming one
 * profile in a single place would make the disagreement impossible instead of
 * merely visible.
 *
 * Both launch routes have to be read: `dsh --profile <name>` keeps the name in
 * argv, while the launcher's entry route consumes the flag and hands it down as
 * `DSH_TUI_PROFILE` - the variable the entry itself reads. A launch that names no
 * profile leaves the question unasked, which the transport answers "not yielded":
 * guessing there would drop a notification.
 * @returns The path, or undefined when this launch names no profile.
 */
export function windowsToastProfileDocument(): string | undefined {
  const profile = resolveDshProfileName() ?? process.env.DSH_TUI_PROFILE?.trim()
  return profile === undefined || profile === '' ? undefined : join(dshHomeDir(), 'profiles', profile, 'package.json')
}
