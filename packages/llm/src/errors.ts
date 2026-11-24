import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

// A failure to reach or be served by the API, after the SDK's own retries. Thrown (not
// returned) so a Temporal activity can retry it durably when `retryable` (ADR-0013).
export class LlmTransportError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor({ status, retryable }: { status: number | null; retryable: boolean }) {
    // Status only: an SDK error message can quote parts of the request.
    super(`LlmTransportError status=${status ?? "none"} retryable=${retryable}`);
    this.name = "LlmTransportError";
    this.status = status;
    this.retryable = retryable;
  }
}

// Statuses worth retrying later: timeout, conflict, rate limit and every server error.
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// Turns an SDK error into an LlmTransportError. Anything else (a bug) is rethrown unchanged.
export function toTransportError(error: unknown): LlmTransportError {
  // Connection problems and timeouts have no status and are always worth retrying.
  if (error instanceof APIConnectionError) {
    return new LlmTransportError({ status: null, retryable: true });
  }
  if (error instanceof APIError && typeof error.status === "number") {
    return new LlmTransportError({
      status: error.status,
      retryable: isRetryableStatus(error.status),
    });
  }
  throw error;
}
