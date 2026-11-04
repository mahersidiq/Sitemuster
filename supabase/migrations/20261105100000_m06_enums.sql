-- Milestone 06: a session that ended without a verified end time — a later session began — is
-- ENDED_UNVERIFIED (decision #79). btree_gist supports the no-overlap exclusion constraint.
-- Separate migration file: a new enum value can only be used after the transaction that adds it
-- has committed.
alter type public.session_status add value if not exists 'ENDED_UNVERIFIED' after 'UNRESOLVED';
create extension if not exists btree_gist with schema extensions;
