/** Chunk → newline-delimited line splitter with a stable prefix. Subprocess stdout/stderr arrives as
 * arbitrary-sized Buffer chunks that don't respect line boundaries — a single 1 KiB write from the
 * child can pack 30 short lines plus the front of a 31st, with the back of that 31st arriving in the
 * next chunk. Forwarding chunks verbatim to a line-prefixing log function shreds those tail lines into
 */
export interface LinePrefixer {
  feed(chunk: Buffer): void;
  flush(): void;
}

export function createLinePrefixer(
  prefix: string,
  emit: (line: string) => void,
): LinePrefixer {
  let buf = "";
  return {
    feed(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line) emit(`${prefix} ${line}`);
      }
    },
    flush(): void {
      if (buf) {
        emit(`${prefix} ${buf}`);
        buf = "";
      }
    },
  };
}
