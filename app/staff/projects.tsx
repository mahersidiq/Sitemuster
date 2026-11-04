import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useOrganizations, useProjects } from '../../src/api/hooks';
import type { ProjectSummary } from '../../src/api/types';
import { managedOrganizationIds, ownedOrganizationIds } from '../../src/auth/routing';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { StatusPill } from '../../src/components/StatusPill';
import { Body, Heading, Title } from '../../src/components/Typography';
import { metersToFeet } from '../../src/projects/format';
import { useAuth } from '../../src/state/auth';
import { colors } from '../../src/theme';

export default function StaffProjectsScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  // Development preview without a backend keeps the labelled wireframe (no fake projects).
  if (!api) {
    return (
      <ShellScreen
        testID="staff-projects"
        title={t('staff.projects.title')}
        body={t('staff.projects.body')}
      />
    );
  }
  return <ProjectList />;
}

function ProjectList() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const projects = useProjects();
  const organizations = useOrganizations();
  const { refetch } = projects;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const managed = managedOrganizationIds(state);
  const owned = ownedOrganizationIds(state);
  const showOrgName = new Set(projects.data?.map((p) => p.organization_id)).size > 1;

  return (
    <Screen testID="staff-projects">
      <Title>{t('projects.title')}</Title>
      {managed.length > 0 ? (
        <AppButton
          label={t('projects.new')}
          onPress={() => router.push('/project/new')}
          testID="new-project"
        />
      ) : null}
      <QueryState
        isLoading={projects.isLoading}
        error={projects.error}
        onRetry={() => void projects.refetch()}
      />
      {projects.data && projects.data.length === 0 ? (
        <Banner
          tone="info"
          text={managed.length > 0 ? t('projects.emptyManager') : t('projects.emptyStaff')}
          testID="projects-empty"
        />
      ) : null}
      {projects.data?.map((project) => (
        <ProjectCard key={project.id} project={project} showOrgName={showOrgName} />
      ))}
      <AppButton
        variant="secondary"
        label={t('invitations.cta')}
        onPress={() => router.push('/invitations')}
        testID="open-invitations"
      />
      {organizations.data
        ?.filter((org) => owned.includes(org.id))
        .map((org) => (
          <Card key={org.id} testID={`org-${org.id}`}>
            <Heading>{org.name}</Heading>
            <Body>{t('org.ownerHint')}</Body>
            <AppButton
              variant="secondary"
              label={t('org.inviteAdmin')}
              onPress={() =>
                router.push({ pathname: '/org/[id]/invite-admin', params: { id: org.id } })
              }
              testID={`invite-admin-${org.id}`}
            />
          </Card>
        ))}
    </Screen>
  );
}

function ProjectCard({ project, showOrgName }: { project: ProjectSummary; showOrgName: boolean }) {
  const { t } = useTranslation();
  const schedule = project.operates_24_7 ? t('projects.open24x7') : t('projects.scheduled');
  return (
    <Card
      onPress={() => router.push({ pathname: '/project/[id]', params: { id: project.id } })}
      accessibilityLabel={t('projects.openProject', { name: project.name })}
      testID={`project-${project.id}`}
    >
      <Heading>{project.name}</Heading>
      <StatusPill status={project.status} />
      {project.project_number ? (
        <Text style={styles.detail}>
          {t('projects.number', { number: project.project_number })}
        </Text>
      ) : null}
      {showOrgName ? <Text style={styles.detail}>{project.organization_name}</Text> : null}
      {project.address ? <Text style={styles.detail}>{project.address}</Text> : null}
      {project.radius_m !== null ? (
        <Text style={styles.detail}>
          {t('projects.circleSummary', {
            meters: project.radius_m,
            feet: metersToFeet(project.radius_m),
            schedule,
          })}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  detail: { fontSize: 15, color: colors.mutedText },
});
