/** Hold a referenced timer so Bun cannot exit 0 while `fn` is still pending.
 * Bun 1.3 can drop the process when no I/O handles remain (Release 32519747728).
 */
export async function withProcessKeepAlive<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const handle = setInterval(
    () => {
      /* keep the event loop referenced */
    },
    2 ** 31 - 1,
  );
  try {
    return await fn();
  } finally {
    clearInterval(handle);
  }
}
