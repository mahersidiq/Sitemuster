import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { WorkerDetailsInput } from '../api/types';
import { colors, spacing } from '../theme';
import { ChipGroup } from './ChipGroup';
import { TextField } from './TextField';

export const EMPTY_DETAILS: WorkerDetailsInput = {
  legalName: '',
  companyId: null,
  companyName: '',
  trade: '',
  emergencyName: '',
  emergencyPhone: '',
  emergencyRelationship: '',
};

const OTHER = 'other';

/** Name, employer, trade and one emergency contact (shared by digital join and supervised onboarding). */
export function WorkerDetailsForm({
  value,
  onChange,
  companies,
}: {
  value: WorkerDetailsInput;
  onChange: (next: WorkerDetailsInput) => void;
  companies: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<WorkerDetailsInput>) => onChange({ ...value, ...patch });
  const selected = value.companyId ?? (companies.length > 0 ? OTHER : null);
  return (
    <View style={styles.container}>
      <TextField
        label={t('join.legalName')}
        value={value.legalName}
        onChangeText={(legalName) => set({ legalName })}
        maxLength={200}
        testID="details-name"
      />
      <Text style={styles.label}>{t('join.employer')}</Text>
      {companies.length > 0 ? (
        <ChipGroup
          label={t('join.employer')}
          options={[
            ...companies.map((c) => ({ value: c.id, label: c.name })),
            { value: OTHER, label: t('join.otherCompany') },
          ]}
          selected={selected ? [selected] : []}
          onToggle={(id) => set({ companyId: id === OTHER ? null : id })}
          testID="details-company"
        />
      ) : null}
      {value.companyId === null ? (
        <TextField
          label={t('join.companyName')}
          value={value.companyName}
          onChangeText={(companyName) => set({ companyName })}
          maxLength={200}
          testID="details-company-name"
        />
      ) : null}
      <Text style={styles.hint}>{t('join.employerHint')}</Text>
      <TextField
        label={t('join.trade')}
        value={value.trade}
        onChangeText={(trade) => set({ trade })}
        maxLength={100}
        testID="details-trade"
      />
      <Text style={styles.label}>{t('join.emergencyTitle')}</Text>
      <Text style={styles.hint}>{t('join.emergencyHint')}</Text>
      <TextField
        label={t('join.emergencyName')}
        value={value.emergencyName}
        onChangeText={(emergencyName) => set({ emergencyName })}
        maxLength={200}
        testID="details-emergency-name"
      />
      <TextField
        label={t('join.emergencyPhone')}
        value={value.emergencyPhone}
        onChangeText={(emergencyPhone) => set({ emergencyPhone })}
        keyboardType="phone-pad"
        maxLength={32}
        testID="details-emergency-phone"
      />
      <TextField
        label={t('join.emergencyRelationship')}
        value={value.emergencyRelationship}
        onChangeText={(emergencyRelationship) => set({ emergencyRelationship })}
        maxLength={64}
        testID="details-emergency-relationship"
      />
    </View>
  );
}

/** Client-side check mirroring the server (the server stays the authority). */
export function detailsError(value: WorkerDetailsInput): string | null {
  if (!value.legalName.trim()) return 'NAME_REQUIRED';
  if (!value.companyId && !value.companyName.trim()) return 'COMPANY_REQUIRED';
  if (!value.emergencyName.trim() || value.emergencyPhone.trim().length < 7) {
    return 'EMERGENCY_CONTACT_REQUIRED';
  }
  return null;
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
});
