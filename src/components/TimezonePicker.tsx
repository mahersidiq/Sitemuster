import { getCalendars } from 'expo-localization';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatNowInZone, isValidTimeZone } from '../projects/format';
import { US_TIME_ZONES } from '../projects/timezones';
import { useLanguage } from '../state/language';
import { colors, minTouchTarget, spacing } from '../theme';

export function deviceTimeZone(): string | null {
  const zone = getCalendars()[0]?.timeZone ?? null;
  return zone && isValidTimeZone(zone) ? zone : null;
}

/** Explicit choice of the SITE's time zone (shifts and reports use it, never the phone's zone). */
export function TimezonePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (zone: string) => void;
}) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const zones = useMemo(() => {
    const device = deviceTimeZone();
    const list: string[] = [...US_TIME_ZONES];
    if (device && !list.includes(device)) list.unshift(device);
    if (value && !list.includes(value)) list.unshift(value);
    return list;
  }, [value]);

  return (
    <View
      style={styles.list}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('timezone.label')}
    >
      <Text style={styles.label}>{t('timezone.label')}</Text>
      <Text style={styles.hint}>{t('timezone.hint')}</Text>
      {zones.map((zone) => {
        const selected = zone === value;
        const name = t(`timezone.names.${zone}`, { defaultValue: zone });
        return (
          <Pressable
            key={zone}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${name}, ${formatNowInZone(zone, activeLocale)}`}
            onPress={() => onChange(zone)}
            style={[styles.row, selected && styles.rowSelected]}
            testID={`timezone-${zone}`}
          >
            <Text style={[styles.name, selected && styles.selectedText]}>{name}</Text>
            <Text style={[styles.detail, selected && styles.selectedText]}>
              {t('timezone.now', { zone, time: formatNowInZone(zone, activeLocale) })}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.xs },
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  row: {
    minHeight: minTouchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.sm,
    justifyContent: 'center',
  },
  rowSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  detail: { fontSize: 14, color: colors.mutedText },
  selectedText: { color: colors.onPrimary },
});
