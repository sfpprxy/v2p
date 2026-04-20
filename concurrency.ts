export type TaskRunner = <T>(run: () => Promise<T>) => Promise<T>;
export type OrderedTaskRunner<TOrder extends string | number> = <T>(
  order: TOrder,
  run: () => Promise<T>,
) => Promise<T>;

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface OrderedQueuedTask<T> extends QueuedTask<T> {
  index: number;
}

export function createConcurrencyLimiter(limit: number): TaskRunner {
  assertPositiveInteger(limit, "limit");

  let activeCount = 0;
  const queuedTasks: QueuedTask<unknown>[] = [];

  return async function runLimited<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queuedTasks.push({ run, resolve, reject } as QueuedTask<unknown>);
      startQueuedTasks();
    });
  };

  function startQueuedTasks(): void {
    while (activeCount < limit) {
      const task = queuedTasks.shift();
      if (task === undefined) {
        return;
      }

      activeCount += 1;
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          activeCount -= 1;
          startQueuedTasks();
        });
    }
  }
}

export function createOrderedConcurrencyRunner<TOrder extends string | number>(
  orders: readonly TOrder[],
  limit: number,
): OrderedTaskRunner<TOrder> {
  assertPositiveInteger(limit, "limit");

  const orderIndexes = new Map<TOrder, number>();
  for (const [index, order] of orders.entries()) {
    if (orderIndexes.has(order)) {
      throw new Error(`Duplicate ordered task key: ${String(order)}`);
    }
    orderIndexes.set(order, index);
  }

  let activeCount = 0;
  let nextStartIndex = 0;
  const queuedTasks = new Map<number, OrderedQueuedTask<unknown>>();

  return async function runOrdered<T>(
    order: TOrder,
    run: () => Promise<T>,
  ): Promise<T> {
    const index = orderIndexes.get(order);
    if (index === undefined) {
      throw new Error(`Unknown ordered task key: ${String(order)}`);
    }
    if (queuedTasks.has(index)) {
      throw new Error(`Duplicate queued task key: ${String(order)}`);
    }

    return new Promise<T>((resolve, reject) => {
      queuedTasks.set(index, {
        index,
        run,
        resolve,
        reject,
      } as OrderedQueuedTask<unknown>);
      startQueuedTasks();
    });
  };

  function startQueuedTasks(): void {
    while (activeCount < limit) {
      const task = queuedTasks.get(nextStartIndex);
      if (task === undefined) {
        return;
      }

      queuedTasks.delete(nextStartIndex);
      nextStartIndex += 1;
      activeCount += 1;
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          activeCount -= 1;
          startQueuedTasks();
        });
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}
