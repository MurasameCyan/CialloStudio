import { useCallback, useEffect, useState } from "react";
import { communityApi } from "@/lib/community/client";
import type { CommunityUser, LoginInput, RegisterInput } from "@/lib/community/types";
import { log } from "@/lib/logger";

export function useCommunityAuth() {
  const [user, setUser] = useState<CommunityUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await communityApi.me();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (input: LoginInput) => {
    const session = await communityApi.login(input);
    setUser(session.user);
    log("ok", `社区登录：${session.user.username}`);
    return session.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const session = await communityApi.register(input);
    setUser(session.user);
    log("ok", `社区注册：${session.user.username}`);
    return session.user;
  }, []);

  const logout = useCallback(async () => {
    await communityApi.logout();
    setUser(null);
    log("info", "社区已退出登录");
  }, []);

  return {
    user,
    loading,
    isAdmin: user?.role === "admin",
    refresh,
    login,
    register,
    logout,
  };
}
