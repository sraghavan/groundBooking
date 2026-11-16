import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, auth, type City, type Ground, type Me, type PaymentAccount, type Team } from './api';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), enabled: !!auth.token, staleTime: 5 * 60_000 });
export const useCities = () => useQuery({ queryKey: ['cities'], queryFn: () => api<City[]>('/cities') });
export const useGrounds = () => useQuery({ queryKey: ['grounds'], queryFn: () => api<Ground[]>('/grounds') });
export const useTeams = () => useQuery({ queryKey: ['teams'], queryFn: () => api<Team[]>('/teams') });
export const usePromoters = (includeInactive = false) => useQuery({ queryKey: ['promoters', includeInactive], queryFn: () => api<Team[]>(`/teams?kind=promoter${includeInactive ? '&includeInactive=true' : ''}`) });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api<PaymentAccount[]>('/accounts') });

/** Mutation that invalidates the given query keys on success. */
export function useApiMutation<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, invalidate: QueryKey[] = [], onSuccess?: (r: TRes, v: TVars) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      onSuccess?.(r, v);
    },
  });
}
