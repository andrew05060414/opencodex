import { AGY_RESPONSE_HEADER, AGY_RESPONSE_MARK } from "./error-map";

/** A stream that has no content or error event within this many bytes is passed through. */
export const AGY_PEEK_LIMIT_BYTES = 64 * 1024;

export type AgyPeek =
  | { kind: "stream"; response: Response }
  | { kind: "error"; errorType: string | undefined; message: string; data: string };

function parseEvent(block: string): { name: string | undefined; data: string } {
  let name: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { name, data: data.join("\n") };
}

function errorOf(data: string): { errorType: string | undefined; message: string } {
  try {
    const parsed = JSON.parse(data) as { error?: { type?: unknown; message?: unknown } };
    return {
      errorType: typeof parsed.error?.type === "string" ? parsed.error.type : undefined,
      message: typeof parsed.error?.message === "string" ? parsed.error.message : data,
    };
  } catch {
    return { errorType: undefined, message: data };
  }
}

/**
 * Read an agy SSE response up to its first content event. An `error` event before content is
 * returned as an error so the caller can map it to a status. Otherwise the buffered bytes are
 * replayed ahead of the rest of the stream, so the client receives the same bytes.
 */
export async function peekAgyStream(response: Response, signal?: AbortSignal): Promise<AgyPeek> {
  const reader = response.body?.getReader();
  if (!reader) return { kind: "stream", response: markAgy(response) };
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let readError: unknown;
  let failed = false;
  let verdict: "error" | "stream" | undefined;
  let errorEvent: { errorType: string | undefined; message: string; data: string } | undefined;
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (verdict === undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end = text.indexOf("\n\n");
      while (end !== -1 && verdict === undefined) {
        const event = parseEvent(text.slice(0, end));
        text = text.slice(end + 2);
        end = text.indexOf("\n\n");
        if (event.name === "error") {
          errorEvent = { ...errorOf(event.data), data: event.data };
          verdict = "error";
        } else if (event.name === "content_block_start" || event.name === "content_block_delta" || event.name === "message_stop") {
          verdict = "stream";
        }
      }
      if (bytes > AGY_PEEK_LIMIT_BYTES) verdict = "stream";
    }
  } catch (error) {
    readError = error;
    failed = true;
    verdict = "stream";
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (verdict === "error" && errorEvent) {
    await reader.cancel().catch(() => {});
    return { kind: "error", errorType: errorEvent.errorType, message: errorEvent.message, data: errorEvent.data };
  }
  return { kind: "stream", response: replayResponse(response, chunks, reader, failed ? readError : undefined, signal) };
}

function markAgy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(AGY_RESPONSE_HEADER, AGY_RESPONSE_MARK);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function replayResponse(
  response: Response,
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readError: unknown,
  signal?: AbortSignal,
): Response {
  let next = 0;
  let errored = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next++]!);
        return;
      }
      if (readError !== undefined && !errored) {
        errored = true;
        controller.error(readError);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set(AGY_RESPONSE_HEADER, AGY_RESPONSE_MARK);
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
