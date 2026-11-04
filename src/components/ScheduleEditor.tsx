import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatLocalTime } from '../projects/format';
import { crossesMidnight, type ShiftBlock } from '../projects/shifts';
import { useLanguage } from '../state/language';
import { colors, spacing } from '../theme';
import { AppButton } from './AppButton';
import { Card } from './Card';
import { ChipGroup } from './ChipGroup';
import { TextField } from './TextField';
import { ToggleRow } from './ToggleRow';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Work schedule: 24/7 switch or one or more shifts (days + local start/end). A shift whose end is
 * before its start runs overnight and counts for the day it starts (spec 06).
 */
export function ScheduleEditor({
  operates24x7,
  onOperates24x7Change,
  blocks,
  onBlocksChange,
  error,
}: {
  operates24x7: boolean;
  onOperates24x7Change: (value: boolean) => void;
  blocks: ShiftBlock[];
  onBlocksChange: (blocks: ShiftBlock[]) => void;
  error: string | null;
}) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const update = (index: number, patch: Partial<ShiftBlock>) =>
    onBlocksChange(blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)));
  const toggleDay = (index: number, day: number) => {
    const block = blocks[index];
    if (!block) return;
    const days = block.days.includes(day)
      ? block.days.filter((d) => d !== day)
      : [...block.days, day].sort((a, b) => a - b);
    update(index, { days });
  };
  const dayOptions = WEEKDAYS.map((day) => ({
    value: day,
    label: t(`weekdays.short.${day}`),
    accessibilityLabel: t(`weekdays.long.${day}`),
  }));

  return (
    <View style={styles.container}>
      <ToggleRow
        label={t('schedule.operates24x7')}
        description={t('schedule.operates24x7Hint')}
        value={operates24x7}
        onValueChange={onOperates24x7Change}
        testID="toggle-24-7"
      />
      {operates24x7 ? null : (
        <>
          {blocks.map((block, index) => (
            <Card key={index} testID={`shift-${index}`}>
              <Text style={styles.heading}>{t('schedule.shiftTitle', { number: index + 1 })}</Text>
              <ChipGroup
                label={t('schedule.daysLabel')}
                options={dayOptions}
                selected={block.days}
                onToggle={(day) => toggleDay(index, day)}
                multiple
                testID={`shift-${index}-day`}
              />
              <View style={styles.times}>
                <View style={styles.time}>
                  <TextField
                    label={t('schedule.start')}
                    value={block.start}
                    onChangeText={(start) => update(index, { start })}
                    placeholder="06:00"
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                    testID={`shift-${index}-start`}
                  />
                </View>
                <View style={styles.time}>
                  <TextField
                    label={t('schedule.end')}
                    value={block.end}
                    onChangeText={(end) => update(index, { end })}
                    placeholder="18:00"
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                    testID={`shift-${index}-end`}
                  />
                </View>
              </View>
              <Text style={styles.hint} testID={`shift-${index}-summary`}>
                {crossesMidnight(block)
                  ? t('schedule.overnightSummary', {
                      start: formatLocalTime(block.start, activeLocale),
                      end: formatLocalTime(block.end, activeLocale),
                    })
                  : t('schedule.daySummary', {
                      start: formatLocalTime(block.start, activeLocale),
                      end: formatLocalTime(block.end, activeLocale),
                    })}
              </Text>
              {blocks.length > 1 ? (
                <AppButton
                  variant="secondary"
                  label={t('schedule.removeShift')}
                  onPress={() => onBlocksChange(blocks.filter((_, i) => i !== index))}
                  testID={`shift-${index}-remove`}
                />
              ) : null}
            </Card>
          ))}
          <Text style={styles.hint}>{t('schedule.timeFormatHint')}</Text>
          <AppButton
            variant="secondary"
            label={t('schedule.addShift')}
            onPress={() =>
              onBlocksChange([...blocks, { days: [1, 2, 3, 4, 5], start: '20:00', end: '04:00' }])
            }
            testID="add-shift"
          />
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error} testID="schedule-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  heading: { fontSize: 17, fontWeight: '700', color: colors.text },
  times: { flexDirection: 'row', gap: spacing.sm },
  time: { flex: 1 },
  hint: { fontSize: 15, color: colors.mutedText },
  error: { color: colors.dangerText, fontSize: 15 },
});
