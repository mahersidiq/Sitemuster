import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../api/errors';
import type { AddressCandidate, ResolvedPlace } from '../api/types';
import { useApi } from '../state/auth';
import { useLanguage } from '../state/language';
import { colors, spacing } from '../theme';
import { Banner } from './Banner';
import { Card } from './Card';
import { TextField } from './TextField';

const MIN_QUERY = 3;
const DEBOUNCE_MS = 350;

/**
 * Address lookup through the authenticated Edge Functions (Google Places (New) + Geocoding; the
 * Google server key never reaches the app). Development backends without a key return clearly
 * labelled fake candidates; production fails closed instead.
 */
export function AddressSearch({ onResolved }: { onResolved: (place: ResolvedPlace) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { activeLocale } = useLanguage();
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [provider, setProvider] = useState<'google' | 'development_fake' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sessionToken, setSessionToken] = useState(() => randomUUID());
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) return undefined;
    const request = ++latest.current;
    // Debounce typing so each keystroke is not a paid lookup (not location polling).
    const handle = setTimeout(() => {
      api
        .searchAddress(trimmed, sessionToken, activeLocale)
        .then((result) => {
          if (request !== latest.current) return;
          setCandidates(result.candidates);
          setProvider(result.provider);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (request !== latest.current) return;
          setCandidates([]);
          setError(t(errorMessageKey(caught)));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [api, query, sessionToken, activeLocale, t]);

  const choose = async (candidate: AddressCandidate) => {
    setResolving(true);
    setError(null);
    try {
      const place = await api.resolveAddress(candidate.placeId, sessionToken, activeLocale);
      latest.current += 1;
      setCandidates([]);
      setQuery('');
      setSessionToken(randomUUID());
      onResolved(place);
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setResolving(false);
    }
  };

  return (
    <View style={styles.container}>
      <TextField
        label={t('site.addressSearch')}
        value={query}
        onChangeText={(next) => {
          setQuery(next);
          if (next.trim().length < MIN_QUERY) setCandidates([]);
        }}
        placeholder={t('site.addressPlaceholder')}
        maxLength={200}
        testID="address-query"
      />
      {provider === 'development_fake' ? (
        <Banner text={t('site.devAddressProvider')} testID="dev-address-provider" />
      ) : null}
      {resolving ? <Text style={styles.hint}>{t('common.loading')}</Text> : null}
      {candidates.map((candidate, index) => (
        <Card
          key={candidate.placeId}
          onPress={() => void choose(candidate)}
          accessibilityLabel={`${candidate.primaryText}, ${candidate.secondaryText}`}
          testID={`address-candidate-${index}`}
        >
          <Text style={styles.primary}>{candidate.primaryText}</Text>
          <Text style={styles.hint}>{candidate.secondaryText}</Text>
        </Card>
      ))}
      {provider === 'google' && candidates.length > 0 ? (
        <Text style={styles.hint}>{t('site.poweredByGoogle')}</Text>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="address-error" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  primary: { fontSize: 17, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
});
