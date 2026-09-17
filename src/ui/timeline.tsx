import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errText } from "../api";
import { useAuth } from "../auth";
import { APP_NAME, type Post } from "../../shared/links";
import Compose from "./compose";
import { PostCard } from "./post";

const PAGE = 30;

/** Shared by the timeline and profile pages: a list of posts with local updates. */
export const usePostList = (load: (before?: string) => Promise<Post[]>) => {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const p = await load();
      setPosts(p);
      setDone(p.length < PAGE);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [load]);

  const more = async () => {
    if (!posts?.length || done || loading) return;
    setLoading(true);
    try {
      const p = await load(posts[posts.length - 1].createdAt);
      setPosts([...posts, ...p]);
      setDone(p.length < PAGE);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };

  const update = (id: string, next: Post | null) =>
    setPosts((ps) => (ps ? (next ? ps.map((p) => (p.id === id ? next : p)) : ps.filter((p) => p.id !== id)) : ps));
  const prepend = (p: Post) => setPosts((ps) => [p, ...(ps || [])]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { posts, error, done, loading, more, update, prepend, reload };
};

const Timeline = () => {
  document.title = APP_NAME;
  const { me } = useAuth();
  const [params] = useSearchParams();
  const load = useCallback((before?: string) => api.posts.list({ limit: PAGE, before }), []);
  const { posts, error, done, loading, more, update, prepend } = usePostList(load);

  return (
    <div className="space-y-5">
      {me && <Compose autoFocus={params.get("compose") === "1"} onPosted={prepend} />}

      {error && <p className="font-mono text-sm text-red-300/80">{error}</p>}
      {posts === null && !error && <p className="font-mono text-sm text-gray-600">Loading…</p>}
      {posts?.length === 0 && <p className="font-mono text-sm text-gray-600">Nothing yet. Be the first.</p>}
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

export default Timeline;
