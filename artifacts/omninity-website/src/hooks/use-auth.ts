/**
 * Auth hook — wraps the generated API client to give the rest of the app a
 * single, stable interface for session state (Task #71).
 *
 * Usage:
 *   const { user, isLoading, isAuthenticated, login, register, logout } = useAuth();
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentUser,
  useLoginUser,
  useRegisterUser,
  useLogoutUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import type { LoginRequest, RegisterRequest } from "@workspace/api-client-react";

export function useAuth() {
  const qc = useQueryClient();

  // Use the default query options — retry logic and staleTime are handled
  // by the global QueryClient config. The auth gate only cares about
  // isLoading / isAuthenticated / isError, so no custom options needed.
  const meQuery = useGetCurrentUser();

  const loginMutation = useLoginUser();
  const registerMutation = useRegisterUser();
  const logoutMutation = useLogoutUser();

  const user = meQuery.data?.data?.user ?? null;
  const isAuthenticated = Boolean(user);
  const isLoading = meQuery.isLoading;

  async function login(body: LoginRequest) {
    await loginMutation.mutateAsync({ data: body });
    await qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  }

  async function register(body: RegisterRequest) {
    await registerMutation.mutateAsync({ data: body });
    await qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  }

  async function logout() {
    await logoutMutation.mutateAsync();
    await qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  }

  return {
    user,
    isAuthenticated,
    isLoading,
    isError: meQuery.isError,
    login,
    register,
    logout,
    loginPending: loginMutation.isPending,
    registerPending: registerMutation.isPending,
    logoutPending: logoutMutation.isPending,
    loginError: loginMutation.error,
    registerError: registerMutation.error,
  };
}
