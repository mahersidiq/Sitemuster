import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useMyEnrollments } from '../api/hooks';
import { loadBadgeProjects, saveBadgeProjects, type BadgeProject } from '../device/device-store';
import { colors } from '../theme';
import { AppButton } from './AppButton';
import { Banner } from './Banner';
import { Card } from './Card';
import { QueryState } from './QueryState';
import { Heading } from './Typography';

/**
 * The worker's projects with honest statuses (pending approval / employer confirmation) and the
 * offline badge for approved ones. Approved project names are remembered on the phone so the badge
 * can be opened without signal.
 */
export function WorkerProjects({ showJoin }: { showJoin: boolean }) {
  const { t } = useTranslation();
  const enrollments = useMyEnrollments();
  const { refetch } = enrollments;
  const [saved, setSaved] = useState<BadgeProject[]>([]);
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  useEffect(() => {
    void loadBadgeProjects().then(setSaved);
  }, []);
  useEffect(() => {
    if (!enrollments.data) return;
    const approved = enrollments.data
      .filter((e) => e.enrollment_status === 'APPROVED')
      .map((e) => ({ id: e.project_id, name: e.project_name }));
    void saveBadgeProjects(approved);
  }, [enrollments.data]);

  const openBadge = (project: BadgeProject) =>
    router.push({
      pathname: '/badge/[projectId]',
      params: { projectId: project.id, name: project.name },
    });

  return (
    <>
      {enrollments.error && saved.length > 0 ? (
        <>
          <Banner text={t('workerProjects.offlineSaved')} testID="projects-offline" />
          {saved.map((project) => (
            <Card key={project.id} testID={`saved-${project.id}`}>
              <Heading>{project.name}</Heading>
              <AppButton label={t('workerProjects.showBadge')} onPress={() => openBadge(project)} />
            </Card>
          ))}
        </>
      ) : (
        <QueryState
          isLoading={enrollments.isLoading}
          error={enrollments.error}
          onRetry={() => void refetch()}
        />
      )}
      {enrollments.data?.length === 0 ? (
        <Banner tone="info" text={t('workerProjects.none')} />
      ) : null}
      {enrollments.data?.map((e) => (
        <Card key={e.enrollment_id} testID={`enrollment-${e.project_id}`}>
          <Heading>{e.project_name}</Heading>
          <Text style={styles.hint}>{e.organization_name}</Text>
          <Text style={styles.value} testID={`enrollment-status-${e.project_id}`}>
            {t(`enrollmentStatus.${e.enrollment_status}`)}
          </Text>
          {e.company_name ? (
            <Text style={styles.hint}>
              {t('workerProjects.employerLine', {
                company: e.company_name,
                status: t(`employerStatus.${e.employer_status}`),
              })}
            </Text>
          ) : null}
          {e.enrollment_status === 'APPROVED' ? (
            <AppButton
              label={t('workerProjects.showBadge')}
              onPress={() => openBadge({ id: e.project_id, name: e.project_name })}
              testID={`show-badge-${e.project_id}`}
            />
          ) : null}
        </Card>
      ))}
      {showJoin ? (
        <AppButton
          variant="secondary"
          label={t('workerProjects.joinAnother')}
          onPress={() => router.push('/join/scan')}
          testID="join-another"
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, color: colors.mutedText },
  value: { fontSize: 17, fontWeight: '600', color: colors.text },
});
