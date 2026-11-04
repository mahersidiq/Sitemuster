import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { TRACKING_DEFAULTS } from '@sitemuster/shared';

import { metersToFeet } from '../projects/format';
import { colors, spacing } from '../theme';
import { AppButton } from './AppButton';
import { ChipGroup } from './ChipGroup';

const MIN = TRACKING_DEFAULTS.geofence_min_radius_m;
const MAX = TRACKING_DEFAULTS.geofence_max_radius_m;
const STEP = 25;
const PRESETS = [150, 250, 500, 1000, 2000] as const;

/** Site radius control bounded to the server limits (150–2,000 m); the server re-validates. */
export function RadiusStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const clamp = (next: number) => Math.min(MAX, Math.max(MIN, next));
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{t('site.radiusLabel')}</Text>
      <View style={styles.row}>
        <View style={styles.button}>
          <AppButton
            variant="secondary"
            label={t('site.radiusDecrease', { step: STEP })}
            onPress={() => onChange(clamp(value - STEP))}
            disabled={value <= MIN}
            testID="radius-decrease"
          />
        </View>
        <Text style={styles.value} accessibilityLiveRegion="polite" testID="radius-value">
          {t('site.radiusValue', { meters: value, feet: metersToFeet(value) })}
        </Text>
        <View style={styles.button}>
          <AppButton
            variant="secondary"
            label={t('site.radiusIncrease', { step: STEP })}
            onPress={() => onChange(clamp(value + STEP))}
            disabled={value >= MAX}
            testID="radius-increase"
          />
        </View>
      </View>
      <ChipGroup
        label={t('site.radiusPresets')}
        options={PRESETS.map((meters) => ({ value: meters, label: t('site.meters', { meters }) }))}
        selected={[value]}
        onToggle={(meters) => onChange(meters)}
        testID="radius-preset"
      />
      <Text style={styles.hint}>{t('site.radiusHint', { min: MIN, max: MAX })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  button: { width: 96 },
  value: { flex: 1, fontSize: 20, fontWeight: '700', color: colors.text, textAlign: 'center' },
  hint: { fontSize: 15, color: colors.mutedText },
});
