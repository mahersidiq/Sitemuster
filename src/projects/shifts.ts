import { normalizeWorkWindows, type WorkWindowInput } from '@sitemuster/shared';

/**
 * The schedule editor groups per-weekday work windows into "shifts" (same start/end on several
 * days). The server stores one row per weekday; these helpers convert both ways losslessly.
 */
export interface ShiftBlock {
  days: number[];
  start: string;
  end: string;
}

export function blocksFromWindows(windows: readonly WorkWindowInput[]): ShiftBlock[] {
  const blocks: ShiftBlock[] = [];
  for (const window of windows) {
    const existing = blocks.find(
      (block) => block.start === window.local_start_time && block.end === window.local_end_time,
    );
    if (existing) {
      if (!existing.days.includes(window.weekday)) existing.days.push(window.weekday);
    } else {
      blocks.push({
        days: [window.weekday],
        start: window.local_start_time,
        end: window.local_end_time,
      });
    }
  }
  for (const block of blocks) block.days.sort((a, b) => a - b);
  return blocks;
}

export function windowsFromBlocks(blocks: readonly ShiftBlock[]): WorkWindowInput[] {
  return blocks.flatMap((block) =>
    [...block.days]
      .sort((a, b) => a - b)
      .map((weekday) => ({ weekday, local_start_time: block.start, local_end_time: block.end })),
  );
}

export type ScheduleError =
  'SHIFT_NEEDS_DAYS' | Exclude<ReturnType<typeof normalizeWorkWindows>, { ok: true }>['error'];

/** Client-side check mirroring the server (the database stays the authority). */
export function validateSchedule(
  blocks: readonly ShiftBlock[],
  operates24x7: boolean,
): { ok: true; windows: WorkWindowInput[] } | { ok: false; error: ScheduleError } {
  if (operates24x7) return { ok: true, windows: [] };
  if (blocks.some((block) => block.days.length === 0))
    return { ok: false, error: 'SHIFT_NEEDS_DAYS' };
  const windows = windowsFromBlocks(blocks);
  const checked = normalizeWorkWindows(windows, false);
  return checked.ok ? { ok: true, windows } : { ok: false, error: checked.error };
}

export function crossesMidnight(block: ShiftBlock): boolean {
  return block.end < block.start;
}
