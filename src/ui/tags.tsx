import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { APP_NAME, POST_NOUN, normalizeTag } from "../../shared/links";
import { PostCard, TagChip } from "./post";
import { usePostList } from "./timeline";

const PAGE = 30;

/** The labels in use, most used first. */
export const useTags = () => {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  useEffect(() => {
    api.posts.tags().then(setTags).catch(() => setTags([]));
  }, []);
  return tags;
};

/** /t/<tag>: every murmur you may see with that label, plus the other labels in use. */
const TagPage = () => {
  const { tag: raw = "" } = useParams();
  const tag = normalizeTag(raw) || raw;
  document.title = `#${tag} · ${APP_NAME}`;
  const all = useTags();
  const load = useCallback((before?: string) => api.posts.list({ limit: PAGE, before, tag }), [tag]);
  const { posts, error, done, loading, more, update } = usePostList(load);

  return (
    <div className="space-y-5">
      <header className="px-1 space-y-3">
        <h1 className="text-3xl font-light tracking-tight">#{tag}</h1>
        {all.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="All labels">
            {all.map((t) => (
              <TagChip key={t.tag} tag={t.tag} count={t.count} active={t.tag === tag} />
            ))}
          </div>
        )}
      </header>
      {error && <p className="font-mono text-sm text-red-300/80">{error}</p>}
      {posts === null && !error && <p className="font-mono text-sm text-gray-600">Loading…</p>}
      {posts?.length === 0 && <p className="font-mono text-sm text-gray-600">No {POST_NOUN} carries #{tag}.</p>}
      {posts?.map((p) => (
        <PostCard key={p.id} post={p} onChange={(n) => update(p.id, n)} />
      ))}
      {posts && posts.length > 0 && !done && (
        <div className="text-center">
          <button onClick={more} disabled={loading} className="btn-quiet">
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
};

export default TagPage;
