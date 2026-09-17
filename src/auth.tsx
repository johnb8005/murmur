import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, deviceName } from "./api";
import type { Author } from "../shared/links";

interface AuthState {
  /** undefined while loading, null when signed out */
  me: Author | null | undefined;
  refresh: () => Promise<void>;
  signIn: (username?: string) => Promise<Author>;
  register: (username: string) => Promise<Author>;
  /** Device link from Settings on another device: registers a passkey here and signs in. */
  linkDevice: (token: string) => Promise<Author>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [me, setMe] = useState<Author | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setMe((await api.auth.status()).user);
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = async (username?: string) => {
    const { challengeId, options } = await api.auth.loginOptions(username ? { username } : undefined);
    const response = await startAuthentication({ optionsJSON: options });
    const { user } = await api.auth.login({ challengeId, response });
    setMe(user);
    return user;
  };

  const register = async (username: string) => {
    const { challengeId, options } = await api.auth.registerOptions({ username });
    const response = await startRegistration({ optionsJSON: options });
    const { user } = await api.auth.register({ challengeId, response, deviceName: deviceName() });
    setMe(user);
    return user;
  };

  const linkDevice = async (token: string) => {
    const { challengeId, options } = await api.auth.linkOptions({ token });
    const response = await startRegistration({ optionsJSON: options });
    const { user } = await api.auth.linkFinish({ challengeId, response, deviceName: deviceName() });
    setMe(user);
    return user;
  };

  const signOut = async () => {
    await api.auth.logout();
    setMe(null);
  };

  return <Ctx.Provider value={{ me, refresh, signIn, register, linkDevice, signOut }}>{children}</Ctx.Provider>;
};

export const useAuth = () => useContext(Ctx);
