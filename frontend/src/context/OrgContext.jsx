import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const OrgContext = createContext(null);
const STORAGE_KEY = 'flowspace.activeOrgId';

export function OrgProvider({ children }) {
  const { accessToken, user } = useAuth();

  const [organizations, setOrganizations] = useState([]);
  const [activeOrgId, setActiveOrgId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!accessToken) {
      setOrganizations([]);
      setLoading(false);
      return [];
    }

    setError(null);
    try {
      const { organizations: list } = await api.listOrgs(accessToken);
      setOrganizations(list);
      return list;
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // Reconcile the remembered org against what the user can actually see.
  //
  // The stored id is a hint from localStorage, not an entitlement — a user
  // can be removed from an org between sessions, or open the app with
  // another account's leftover value. If it is not in the list the server
  // returned, it is discarded. The server would reject it anyway; this
  // just stops the UI sitting on an org it will never load.
  useEffect(() => {
    if (loading) return;

    const stored = window.localStorage.getItem(STORAGE_KEY);
    const isValid = (id) => organizations.some((org) => org.id === id);

    if (activeOrgId && isValid(activeOrgId)) return;

    const next = isValid(stored) ? stored : (organizations[0]?.id ?? null);
    setActiveOrgId(next);

    if (next) window.localStorage.setItem(STORAGE_KEY, next);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, [organizations, activeOrgId, loading]);

  // Clear the remembered org on sign-out so the next account on this
  // browser does not inherit it.
  useEffect(() => {
    if (!user) {
      setActiveOrgId(null);
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, [user]);

  const selectOrg = useCallback((orgId) => {
    setActiveOrgId(orgId);
    if (orgId) window.localStorage.setItem(STORAGE_KEY, orgId);
  }, []);

  const createOrg = useCallback(
    async ({ name, slug }) => {
      const { organization } = await api.createOrg(accessToken, { name, slug });
      await refresh();
      selectOrg(organization.id);
      return organization;
    },
    [accessToken, refresh, selectOrg]
  );

  const activeOrg = useMemo(
    () => organizations.find((org) => org.id === activeOrgId) ?? null,
    [organizations, activeOrgId]
  );

  const value = useMemo(
    () => ({
      organizations,
      activeOrg,
      activeOrgId,
      role: activeOrg?.role ?? null,
      loading,
      error,
      selectOrg,
      createOrg,
      refresh,
    }),
    [organizations, activeOrg, activeOrgId, loading, error, selectOrg, createOrg, refresh]
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (!context) throw new Error('useOrg must be used inside <OrgProvider>');
  return context;
}
