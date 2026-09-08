import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, errText } from "../api";
import { APP_NAME, type Author } from "../../shared/links";
import { PostCard } from "./post";
import { usePostList } from "./timeline";

const Profile = () => {
  const { username = "" } = useParams();
  const [user, setUser] = useState<Author | null>(null);
  const [userError, setUserError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      const r = await api.users.get({ username, before });
      setUser(r.user);
      return r.posts;
    },
    [username]
  );
  const { posts, error, done, loading, more, update } = usePostList(load);

  useEffect(() => {
    setUserError(null);
    api.users
      .get({ username })
      .then((r) => {
        setUser(r.user);
        document.title = `@${r.user.username} · ${APP_NAME}`;
      })
      .catch((e) => setUserError(errText(e)));
  }, [username]);

  return (
    <div className="space-y-5">
      <header className="px-1">
        <h1 className="text-3xl font-light tracking-tight">{user?.displayName || username}</h1>
        <p className="font-mono text-sm text-gray-500">@{user?.username || username}</p>
      </header>
      {(userError || error) && <p className="font-mono text-sm text-red-300/80">{userError || error}</p>}
      {posts === null && !error && !userError && <p className="font-mono text-sm text-gray-600">Loading…</p>}
      {posts?.length === 0 && <p className="font-mono text-sm text-gray-600">No posts yet.</p>}
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

export default Profile;
