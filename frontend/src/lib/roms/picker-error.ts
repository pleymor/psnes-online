/**
 * Turns a caught error from a folder or file picker into a message a user
 * should see, or `null` if there is nothing to show.
 *
 * Pressing Escape or clicking Cancel on `showDirectoryPicker` rejects with a
 * DOMException named `AbortError` - a player changing their mind, not a
 * failure of anything. Painting that as a red banner ("The user aborted a
 * request.") would train players to associate cancelling with breakage. The
 * two components that called this correctly before this function existed
 * each carried the same check as an inline comment; a third copy is how it
 * gets forgotten a second time.
 */
export function pickerError(err: unknown): string | null {
	if ((err as { name?: string })?.name === 'AbortError') return null;
	return err instanceof Error ? err.message : String(err);
}
