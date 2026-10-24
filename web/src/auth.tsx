import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Me { id: string; email: string; name: string; role: string }
interface AuthState { user: Me | null; permissions: string[]; needsSetup: boolean; can: (p: string) => boolean; refresh: () => void }

const Ctx = createContext<AuthState>({ user: null, permissions: [], needsSetup: false, can: () => false, refresh: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth'], queryFn: () => api.get<{ user: Me | null; permissions: string[]; needsSetup: boolean }>('/auth/status'), staleTime: 60_000 });
  if (q.isLoading) return <div className="empty">Loading…</div>;
  if (q.error || !q.data) return <div className="empty">Cannot reach the billing server. Start it with <code>npm run dev</code>, then <button className="btn sm" onClick={() => q.refetch()}>retry</button>.</div>;
  const s = q.data;
  const value: AuthState = {
    user: s.user,
    permissions: s.permissions,
    needsSetup: s.needsSetup,
    can: (p) => s.permissions.includes(p),
    refresh: () => qc.invalidateQueries(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
