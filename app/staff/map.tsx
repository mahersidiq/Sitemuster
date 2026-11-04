import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { queryKeys, useProjectDashboard, useProjectMap } from '../../src/api/hooks';
import { Banner } from '../../src/components/Banner';
import { DemoBanner } from '../../src/components/DemoBanner';
import { Card } from '../../src/components/Card';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ShellScreen } from '../../src/components/ShellScreen';
import { Heading } from '../../src/components/Typography';
import { useNow } from '../../src/components/useNow';
import { Hint, LiveStatusLine, ProjectHeader, StatLine } from '../../src/dashboard/components';
import { markerAge, wholeMinutes } from '../../src/dashboard/format';
import { LiveSiteMap, MapErrorBoundary, type ShownMarker } from '../../src/dashboard/LiveSiteMap';
import { useLiveState } from '../../src/realtime/ProjectLive';
import { useAuth } from '../../src/state/auth';
import { useSelectedProject } from '../../src/state/selected-project';
import { colors } from '../../src/theme';

export default function StaffMapScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  if (!api) {
    return (
      <ShellScreen testID="staff-map" title={t('staff.map.title')} body={t('staff.map.body')} />
    );
  }
  return <LiveMap />;
}

/**
 * The site map (docs/spec/01 "map"; spec 03 privacy assertions; decision #105). Only location
 * roles see positions; each has its time and accuracy, stale ones are labelled "not live", and
 * the attendance numbers below never depend on the map rendering.
 */
function LiveMap() {
  const { t } = useTranslation();
  const { projectId } = useSelectedProject();
  const live = useLiveState();
  const queryClient = useQueryClient();
  const dashboard = useProjectDashboard(projectId);
  const allowed = dashboard.data?.can_view_map ?? false;
  const map = useProjectMap(projectId, allowed);
  const { refetch } = map;
  useFocusEffect(
    useCallback(() => {
      if (projectId && allowed) void refetch();
    }, [projectId, allowed, refetch]),
  );
  const now = useNow(30_000);
  const shown = useMemo<ShownMarker[]>(() => {
    const data = map.data;
    if (!data) return [];
    return data.markers.flatMap((marker) => {
      const age = markerAge(marker, data, map.dataUpdatedAt, now.getTime());
      if (age.expired) return [];
      const minutes = wholeMinutes(age.ageMs);
      return [
        {
          marker,
          fresh: age.fresh,
          description: t(age.fresh ? 'liveMap.fresh' : 'liveMap.stale', {
            accuracy: marker.accuracy_m,
            minutes,
          }),
        },
      ];
    });
  }, [map.data, map.dataUpdatedAt, now, t]);
  const counts = dashboard.data?.counts;

  return (
    <Screen testID="staff-map">
      <ProjectHeader />
      {projectId ? (
        <>
          <LiveStatusLine
            state={live}
            updatedAt={allowed ? map.dataUpdatedAt : dashboard.dataUpdatedAt}
            error={
              allowed
                ? (map.error ?? map.failureReason)
                : (dashboard.error ?? dashboard.failureReason)
            }
            paused={(allowed ? map.fetchStatus : dashboard.fetchStatus) === 'paused'}
            onRefresh={() => {
              void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(projectId) });
              void queryClient.invalidateQueries({ queryKey: queryKeys.projectMap(projectId) });
            }}
          />
          <QueryState
            isLoading={dashboard.isLoading || (allowed && map.isLoading)}
            error={(dashboard.data ? null : dashboard.error) ?? (map.data ? null : map.error)}
            onRetry={() => {
              void dashboard.refetch();
              if (allowed) void refetch();
            }}
          />
          <DemoBanner projectId={projectId} />
          {dashboard.data && !allowed ? (
            <Banner tone="info" text={t('liveMap.notAllowed')} testID="map-not-allowed" />
          ) : null}
          {allowed && map.data ? (
            <>
              <Hint text={t('liveMap.privacy')} />
              {map.data.site ? (
                <MapErrorBoundary
                  fallback={
                    <Banner
                      tone="warning"
                      text={t('liveMap.unavailable')}
                      testID="map-unavailable"
                    />
                  }
                >
                  <LiveSiteMap
                    site={map.data.site}
                    markers={shown}
                    accessibilityLabel={t('liveMap.mapLabel', { count: shown.length })}
                  />
                </MapErrorBoundary>
              ) : null}
              <Hint text={t('liveMap.legendSite')} />
              <Hint text={t('liveMap.legendStale')} />
              <Card testID="map-markers">
                <Heading>{t('liveMap.markers')}</Heading>
                {shown.length === 0 ? <Hint text={t('liveMap.none')} /> : null}
                {shown.map(({ marker, fresh, description }) => (
                  <Text
                    key={marker.worker_id}
                    style={[styles.line, fresh ? styles.fresh : styles.stale]}
                    testID={`marker-${marker.worker_id}`}
                  >
                    {`${marker.legal_name}${marker.company_name ? ` (${marker.company_name})` : ''}: ${description}`}
                  </Text>
                ))}
              </Card>
            </>
          ) : null}
          {counts ? (
            <Card testID="map-attendance">
              <StatLine
                text={t('liveMap.summary', {
                  onsite: counts.estimated_onsite,
                  unknown: counts.presence_unknown,
                })}
                testID="map-attendance-summary"
              />
              <Hint text={t('dashboard.estimateNote')} />
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: 16, paddingVertical: 2 },
  fresh: { color: colors.text },
  stale: { color: colors.mutedText, fontStyle: 'italic' },
});
