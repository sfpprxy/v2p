import chalk from "chalk";
import { MultiBar, Presets, SingleBar } from "cli-progress";

const DEFAULT_VISIBLE_PROGRESS_SLOT_COUNT = 20;

export type ProgressPayload = Record<string, string>;

export interface ProgressDisplay {
  multibar: MultiBar;
  totalBar: SingleBar;
  itemBars: SingleBar[];
  emptyPayload: ProgressPayload;
}

export interface ProgressDisplayOptions {
  totalLabel: string;
  itemFormat: string;
  emptyPayload: ProgressPayload;
  visibleItemCount?: number;
}

export interface ProgressItem {
  rank: number;
  isComplete: boolean;
  value: number;
  total: number;
  completedMs: number | null;
  completedVisibleMs: number | null;
  payload: ProgressPayload;
}

export function createProgressDisplay(
  totalItemCount: number,
  totalProgressTitle: string,
  options: ProgressDisplayOptions,
): ProgressDisplay {
  const multibar = new MultiBar(
    {
      format: [
        chalk.dim(options.totalLabel),
        chalk.cyan("{bar}"),
        chalk.bold("{value}/{total}"),
        chalk.dim("{percentage}%"),
        chalk.dim("{title}"),
      ].join(" "),
      barCompleteChar: "█",
      barIncompleteChar: "░",
      barsize: 26,
      hideCursor: true,
      emptyOnZero: true,
    },
    Presets.shades_classic,
  );
  return {
    multibar,
    totalBar: multibar.create(totalItemCount, 0, {
      title: totalProgressTitle,
    }),
    itemBars: Array.from(
      {
        length: Math.min(
          totalItemCount,
          options.visibleItemCount ?? DEFAULT_VISIBLE_PROGRESS_SLOT_COUNT,
        ),
      },
      () =>
        multibar.create(1, 0, { ...options.emptyPayload }, {
          format: options.itemFormat,
        }),
    ),
    emptyPayload: { ...options.emptyPayload },
  };
}

export function updateProgressBars(
  progressDisplay: ProgressDisplay,
  items: readonly ProgressItem[],
): void {
  const now = performance.now();
  const visibleItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!item.isComplete || item.completedVisibleMs === null) {
        return true;
      }
      return (
        item.completedMs !== null &&
        now - item.completedMs <= item.completedVisibleMs
      );
    })
    .sort((left, right) => {
      if (left.item.rank !== right.item.rank) {
        return left.item.rank - right.item.rank;
      }
      return left.index - right.index;
    });

  for (const [index, itemBar] of progressDisplay.itemBars.entries()) {
    const visibleItem = visibleItems[index];
    if (visibleItem === undefined) {
      itemBar.update(0, { ...progressDisplay.emptyPayload });
      continue;
    }
    itemBar.setTotal(visibleItem.item.total);
    itemBar.update(visibleItem.item.value, visibleItem.item.payload);
  }
}
