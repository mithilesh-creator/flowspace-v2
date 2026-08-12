import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { supabase } from '../lib/supabase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // getSession() reads the persisted session synchronously from storage
    // and refreshes it if stale. Until it resolves we cannot tell a
    // signed-out user from a signed-in one whose session is still
    // loading, which is why `loading` gates the router.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    // Fires on sign-in, sign-out, and every silent token refresh. The
    // refresh case matters: the access token in `session` changes roughly
    // hourly, and anything holding a stale copy (the socket, in-flight
    // requests) needs to see the new one.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      accessToken: session?.access_token ?? null,
      loading,

      signIn: (email, password) =>
        supabase.auth.signInWithPassword({ email, password }),

      signUp: (email, password, fullName) =>
        supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName || null } },
        }),

      signOut: () => supabase.auth.signOut(),
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
