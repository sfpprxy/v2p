export type RetryDecision = "retry" | "throw";

export interface RetryPolicy {
  maxAttempts: number;
  decide: (error: unknown, attemptCount: number) => RetryDecision;
  onAttemptStarted?: (attemptCount: number, maxAttempts: number) => void;
}

export class RetryExecutionError extends Error {
  cause: unknown;
  attemptCount: number;

  constructor(error: unknown, attemptCount: number) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "RetryExecutionError";
    this.cause = error;
    this.attemptCount = attemptCount;
  }
}

export async function runWithRetry<T>(
  run: (attemptCount: number) => Promise<T>,
  retryPolicy: RetryPolicy,
): Promise<{ value: T; attemptCount: number }> {
  let attemptCount = 0;
  while (true) {
    attemptCount += 1;
    retryPolicy.onAttemptStarted?.(attemptCount, retryPolicy.maxAttempts);
    try {
      return {
        value: await run(attemptCount),
        attemptCount,
      };
    } catch (error) {
      if (
        attemptCount >= retryPolicy.maxAttempts ||
        retryPolicy.decide(error, attemptCount) === "throw"
      ) {
        throw new RetryExecutionError(error, attemptCount);
      }
    }
  }
}
