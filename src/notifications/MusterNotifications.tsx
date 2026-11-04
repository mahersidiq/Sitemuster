import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '../api/hooks';
import { latestSelfReport } from '../muster/format';
import { effectiveOutcome } from '../outbox/outbox';
import { useAuth } from '../state/auth';
import { useOutbox } from '../state/outbox';
import { configureMusterNotifications, musterActionFromResponse } from './muster-alerts';

/** Notification taps already handled in this app run (a response can be delivered twice). */
const handled = new Set<string>();

/** Test hook. */
export function resetHandledMusterResponses(): void {
  handled.clear();
}

/**
 * Connects muster alerts to the app (mounted once under the providers):
 * - the channel and the I'M SAFE button follow the app language;
 * - an alert arriving while the app is open refreshes the worker's muster card at once;
 * - the I'M SAFE button on an alert queues the worker's own self-report in the outbox (it opens
 *   the app on an unlocked phone, so the signed-in worker is the one answering); a plain tap
 *   opens the worker home with the I'M SAFE card. Nothing is sent for a signed-out phone.
 */
export function MusterNotifications() {
  const { t, i18n } = useTranslation();
  const { state } = useAuth();
  const outbox = useOutbox();
  const queryClient = useQueryClient();
  const last = Notifications.useLastNotificationResponse();

  useEffect(() => {
    configureMusterNotifications({
      channelName: t('muster.push.channel'),
      safeButton: t('muster.worker.imSafe'),
    }).catch((error: unknown) => {
      console.warn(
        'muster alerts: channel not set up',
        error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      );
    });
  }, [t, i18n.language]);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as Record<string, unknown> | undefined;
      if (data?.type === 'MUSTER') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.myMusters });
      }
    });
    return () => subscription.remove();
  }, [queryClient]);

  const signedInWorker =
    state.status === 'signed_in' && state.access.worker_profile_id !== null
      ? state.access.user_id
      : null;
  const outboxReady = outbox.status !== null;
  const { entries, enqueue } = outbox;

  useEffect(() => {
    const action = musterActionFromResponse(last);
    if (!action || handled.has(action.responseId)) return;
    // Wait for the stored session to be restored before deciding.
    if (state.status === 'loading') return;
    if (!signedInWorker) {
      // Signed out, or not a worker on this phone: nothing is sent for anyone.
      handled.add(action.responseId);
      return;
    }
    // Signed in: the person's outbox opens a moment later.
    if (!outboxReady) return;
    handled.add(action.responseId);
    void queryClient.invalidateQueries({ queryKey: queryKeys.myMusters });
    if (action.kind === 'IM_SAFE') {
      const previous = latestSelfReport(entries, action.musterId);
      if (!previous || effectiveOutcome(previous) === 'REJECTED') {
        enqueue(
          {
            project_id: action.projectId,
            operation_type: 'MUSTER_SELF_REPORT',
            observed_at: new Date().toISOString(),
            payload: {
              muster_id: action.musterId,
              action: 'SELF_REPORT',
              channel: 'NOTIFICATION_ACTION',
            },
          },
          { title: t('muster.worker.imSafe') },
        ).catch((error: unknown) => {
          console.warn(
            'muster alerts: answer not queued',
            error instanceof Error ? error.message.slice(0, 120) : 'unknown',
          );
        });
      }
    }
    router.push('/worker/home');
    Notifications.clearLastNotificationResponseAsync().catch((error: unknown) => {
      console.warn(
        'muster alerts: tap not cleared',
        error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      );
    });
  }, [last, state.status, signedInWorker, outboxReady, entries, enqueue, queryClient, t]);

  return null;
}
