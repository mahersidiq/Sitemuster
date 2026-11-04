import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../api/errors';
import { useApi } from '../state/auth';
import { spacing } from '../theme';
import { AppButton } from './AppButton';
import { Banner } from './Banner';
import { TextField } from './TextField';
import { Heading } from './Typography';
import { hideOnAuthError } from '../api/hooks';

/** The worker's own emergency contact (only emergency-role staff on their projects can read it). */
export function EmergencyContactSection() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const contact = hideOnAuthError(
    useQuery({
      queryKey: ['my-emergency-contact'],
      queryFn: () => api.getMyEmergencyContact(),
    }),
  );
  const [draft, setDraft] = useState<{ name: string; phone: string; relationship: string } | null>(
    null,
  );
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const current = draft ?? {
    name: contact.data?.name ?? '',
    phone: contact.data?.phone ?? '',
    relationship: contact.data?.relationship ?? '',
  };

  const save = async () => {
    try {
      await api.updateMyEmergencyContact({
        name: current.name,
        phone: current.phone,
        relationship: current.relationship || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['my-emergency-contact'] });
      setDraft(null);
      setMessage({ tone: 'success', text: t('profile.emergencySaved') });
    } catch (caught) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(caught)) });
    }
  };

  if (contact.isLoading) return null;
  return (
    <View style={{ gap: spacing.sm }} testID="emergency-section">
      <Heading>{t('join.emergencyTitle')}</Heading>
      <TextField
        label={t('join.emergencyName')}
        value={current.name}
        onChangeText={(name) => setDraft({ ...current, name })}
        maxLength={200}
        testID="profile-emergency-name"
      />
      <TextField
        label={t('join.emergencyPhone')}
        value={current.phone}
        onChangeText={(phone) => setDraft({ ...current, phone })}
        keyboardType="phone-pad"
        maxLength={32}
        testID="profile-emergency-phone"
      />
      <TextField
        label={t('join.emergencyRelationship')}
        value={current.relationship}
        onChangeText={(relationship) => setDraft({ ...current, relationship })}
        maxLength={64}
        testID="profile-emergency-relationship"
      />
      <AppButton
        variant="secondary"
        label={t('profile.saveEmergency')}
        onPress={() => void save()}
        disabled={draft === null}
        testID="profile-emergency-save"
      />
      {message ? (
        <Banner tone={message.tone} text={message.text} testID="profile-emergency-message" />
      ) : null}
    </View>
  );
}
