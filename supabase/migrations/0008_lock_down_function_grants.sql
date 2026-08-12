-- 0008 — actually close the helper functions to anon
--
-- 0004 and 0006 did `revoke execute ... from public` and assumed that
-- covered the anon role. It does not.
--
-- `public` is the pseudo-role every role inherits, but Supabase also
-- issues a *direct* grant of EXECUTE on functions in the public schema to
-- `anon` and `authenticated`, via default privileges owned by postgres. A
-- direct grant is not touched by revoking from the pseudo-role, so every
-- helper stayed callable at /rest/v1/rpc/<name> without signing in.
--
-- Caught by the Supabase database linter, lints 0028/0029:
-- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
--
-- Nothing was actually leaking. Each function either resolves auth.uid()
-- to null and returns false/null, or raises 'authentication required'.
-- But a SECURITY DEFINER function reachable by an unauthenticated caller
-- is exactly the shape of thing that becomes a hole the moment someone
-- edits it without remembering who can reach it.

revoke execute on function public.is_org_member(uuid) from anon;
revoke execute on function public.has_org_role(uuid, public.org_role[]) from anon;
revoke execute on function public.current_org_role(uuid) from anon;
revoke execute on function public.shares_org_with(uuid) from anon;
revoke execute on function public.create_organization(text, text) from anon;
revoke execute on function public.accept_invitation(text) from anon;

-- Trigger functions are not an API. Postgres refuses to call them
-- directly ("trigger functions can only be called as triggers"), so this
-- is tidiness rather than a fix — but leaving them listed in the exposed
-- RPC surface is noise that hides real findings in the linter output.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.prevent_last_owner_removal() from anon, authenticated, public;
revoke execute on function public.set_updated_at() from anon, authenticated, public;
