import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { canOpenStaffShell } from '../auth/routing';
import { useAuth } from '../state/auth';
import { LoadingScreen } from './LoadingScreen';

/**
 * Screen guard for staff-only stack screens (projects, invitations to manage). It only picks the
 * screen; every read and write is still authorized by the server (RLS + RPC checks, aal2).
 */
export function StaffGate({ children }: { children: ReactNode }) {
  const { state, api } = useAuth();
  // Wait for the stored session to load so deep links are not bounced while signing back in.
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || !canOpenStaffShell(state)) return <Redirect href="/" />;
  return <>{children}</>;
}
