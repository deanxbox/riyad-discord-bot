export function logError(context, error) {
  console.error(context, error);
  // Fatal storage failures must not leave the bot running with uncertain state.
  if (String(error?.code).startsWith('ERR_SQLITE')) queueMicrotask(() => { throw error; });
}
