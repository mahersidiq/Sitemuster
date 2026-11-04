-- Milestone 12: new platform operator actions. A separate migration because a value added to an
-- enum can only be used after the transaction that added it has committed.
alter type public.platform_operator_action add value 'LEGAL_NOTICE_LIST';
alter type public.platform_operator_action add value 'LEGAL_NOTICE_APPROVE';
alter type public.platform_operator_action add value 'LEGAL_NOTICE_RETIRE';
alter type public.platform_operator_action add value 'RETENTION_HOLD_SET';
alter type public.platform_operator_action add value 'RETENTION_HOLD_RELEASE';
alter type public.platform_operator_action add value 'STAFF_MFA_RESET';
alter type public.platform_operator_action add value 'SECURITY_FLAGS_LIST';
alter type public.platform_operator_action add value 'SECURITY_FLAG_REVIEW';
