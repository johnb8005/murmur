import React from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { APP_NAME } from "../../shared/links";
import Compose from "./compose";

/**
 * Web Share Target (manifest.share_target): Android and desktop Chrome open this URL with
 * ?title=&text=&url= when the installed app is picked in a share sheet. Shared links often arrive
 * in `text` rather than `url`, so the pieces are merged and de-duplicated into one draft.
 */
const draftFrom = (params: URLSearchParams) => {
  const title = (params.get("title") || "").trim();
  const text = (params.get("text") || "").trim();
  const url = (params.get("url") || "").trim();
  const parts: string[] = [];
  if (title && !text.includes(title)) parts.push(title);
  if (text) parts.push(text);
  if (url && !text.includes(url) && !title.includes(url)) parts.push(url);
  return parts.join("\n");
};

const SharePage = () => {
  document.title = `Share · ${APP_NAME}`;
  const { me } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  if (me === undefined) return <p className="font-mono text-sm text-gray-600">Loading…</p>;
  if (me === null) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  return (
    <div className="space-y-4">
      <h1 className="px-1 text-2xl font-light tracking-tight">Share to {APP_NAME}</h1>
      <Compose initial={draftFrom(params)} autoFocus onPosted={(p) => navigate(`/p/${p.id}`, { replace: true })} />
    </div>
  );
};

export default SharePage;
