import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { APP_NAME } from "../../shared/links";
import Compose from "./compose";

/**
 * Web Share Target (manifest.share_target): Android and desktop Chrome open this URL when the
 * installed app is picked in a share sheet. Text and links arrive as ?title=&text=&url= (shared
 * links often sit in `text` rather than `url`, so the pieces are merged and de-duplicated into one
 * draft). A shared picture is POSTed; the service worker (public/share-target.js) parks it in the
 * Cache API and redirects here with ?files=1, and it is picked up below.
 */

const takeSharedFile = async (): Promise<File | null> => {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open("share-target");
    const res = await cache.match("/share/incoming");
    if (!res) return null;
    await cache.delete("/share/incoming");
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get("x-file-name") || "image");
    return new File([blob], name, { type: res.headers.get("content-type") || blob.type });
  } catch {
    return null;
  }
};
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
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [missing, setMissing] = useState<string | null>(params.get("error"));

  useEffect(() => {
    if (params.get("files") !== "1") return;
    takeSharedFile().then((f) => (f ? setFile(f) : setMissing("The shared picture did not make it here. Attach it with the Photo button.")));
  }, [params]);

  return (
    <div className="space-y-4">
      <h1 className="px-1 text-2xl font-light tracking-tight">Share to {APP_NAME}</h1>
      {missing && <p className="px-1 font-mono text-xs text-yellow-300/80">{missing}</p>}
      <Compose initial={draftFrom(params)} initialImage={file} autoFocus onPosted={(p) => navigate(`/p/${p.id}`, { replace: true })} />
    </div>
  );
};

export default SharePage;
