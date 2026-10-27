import { useQuery } from '@tanstack/react-query';
import { platformGamesApi } from '@/api/platformGamesApi';
import { useAuthStore } from '@/stores/authStore';

/** One account-fenced catalog cache for the home page and game workspaces. */
export function useGameCatalog() {
  const epoch = useAuthStore((state) => state.authEpoch);
  return useQuery({
    queryKey: ['platform', 'games', epoch],
    queryFn: platformGamesApi.listGames,
    staleTime: 5 * 60 * 1000,
  });
}
