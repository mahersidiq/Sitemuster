import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useForemanProjects } from '../api/hooks';
import { AppButton } from '../components/AppButton';
import { Card } from '../components/Card';
import { Heading } from '../components/Typography';
import { colors } from '../theme';

/** Worker home: a verified foreman's crews (company-only; the server re-checks every action). */
export function ForemanCard() {
  const { t } = useTranslation();
  const projects = useForemanProjects();
  const { refetch } = projects;
  // Tabs stay mounted: re-read on focus (a foreman role can be granted while the app is open).
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  if (!projects.data || projects.data.length === 0) return null;
  return (
    <Card testID="foreman-card">
      <Heading>{t('crew.open')}</Heading>
      <AppButton
        label={t('foremanReports.open')}
        onPress={() => router.push('/foreman/reports')}
        testID="foreman-reports-open"
      />
      {projects.data.map((entry) => (
        <Card key={`${entry.project_id}|${entry.company_id}`}>
          <Text style={styles.line}>{`${entry.company_name} · ${entry.project_name}`}</Text>
          <AppButton
            label={t('crew.open')}
            onPress={() =>
              router.push({
                pathname: '/foreman/crew',
                params: {
                  projectId: entry.project_id,
                  companyId: entry.company_id,
                  projectName: entry.project_name,
                  companyName: entry.company_name,
                },
              })
            }
            testID={`crew-open-${entry.project_id}`}
          />
          {entry.kiosk_grant ? (
            <AppButton
              variant="secondary"
              label={t('crew.kiosk')}
              onPress={() =>
                router.push({
                  pathname: '/foreman/kiosk',
                  params: {
                    projectId: entry.project_id,
                    companyId: entry.company_id,
                    projectName: entry.project_name,
                  },
                })
              }
              testID={`crew-kiosk-${entry.project_id}`}
            />
          ) : null}
        </Card>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({ line: { fontSize: 16, color: colors.text } });
