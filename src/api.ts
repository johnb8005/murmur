// Typed oRPC client. The router type comes straight from the server (types only, nothing bundled).

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../server/router";

const link = new RPCLink({ url: `${window.location.origin}/rpc` });

export const api: RouterClient<AppRouter> = createORPCClient(link);

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A label for the passkey being registered, e.g. "iOS · 2026-09-08". */
export const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  return `${os} · ${new Date().toISOString().slice(0, 10)}`;
};

export const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: s > 365 * 86400 ? "numeric" : undefined });
};
