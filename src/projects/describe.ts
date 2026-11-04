import type { TFunction } from 'i18next';

import { formatLocalTime } from './format';
import { crossesMidnight, type ShiftBlock } from './shifts';

/** Human summary per shift, e.g. "Mon, Tue, Wed: 6:00 AM – 6:00 PM" (localized). */
export function describeBlocks(
  blocks: readonly ShiftBlock[],
  t: TFunction,
  locale: string,
): string[] {
  return blocks.map((block) => {
    const days = block.days.map((day) => t(`weekdays.short.${day}`)).join(', ');
    const start = formatLocalTime(block.start, locale);
    const end = formatLocalTime(block.end, locale);
    return crossesMidnight(block)
      ? t('schedule.shiftLineOvernight', { days, start, end })
      : t('schedule.shiftLine', { days, start, end });
  });
}
