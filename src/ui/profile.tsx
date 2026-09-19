import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME, POST_NOUN, type Author } from "../../shared/links";
import { DeviceLinkCard, useDeviceLink } from "./link";
import { PostCard } from "./post";
import { usePostList } from "./timeline";

const Profile = () => {
  const { username = "" } = useParams();
  const { me } = useAuth();
  const [user, setUser] = useState<Author | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const mine = !!me && !!user && me.id === user.id;
  // your own profile is where you bring in another phone or laptop: passkey here, QR code there
  const linking = useDeviceLink();

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
      <header className="px-1 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-light tracking-tight truncate">{user?.displayName || username}</h1>
          <p className="font-mono text-sm text-gray-500">@{user?.username || username}</p>
        </div>
        {mine && (
          <div className="flex items-center gap-4 shrink-0 pb-1">
            <button onClick={linking.make} disabled={linking.busy} className="btn-quiet" aria-label="Add another device" title="Add another phone or laptop to this account">
              <Icon name="qr" size={16} />
              <span className="hidden sm:inline">{linking.busy ? "Waiting for your passkey…" : "Add another device"}</span>
            </button>
            <Link to="/settings" className="hover:text-gray-200 text-gray-500 transition-colors" title="Settings">
              <Icon name="settings" size={16} />
            </Link>
          </div>
        )}
      </header>
      {mine && linking.open && <DeviceLinkCard state={linking} />}
      {(userError || error) && <p className="font-mono text-sm text-red-300/80">{userError || error}</p>}
      {posts === null && !error && !userError && <p className="font-mono text-sm text-gray-600">Loading…</p>}
      {posts?.length === 0 && <p className="font-mono text-sm text-gray-600">No {POST_NOUN}s yet.</p>}
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
