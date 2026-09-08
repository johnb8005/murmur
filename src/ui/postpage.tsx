import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errText, timeAgo } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME, COMMENT_MAX, type Comment, type Post } from "../../shared/links";
import { PostCard } from "./post";

const PostPage = () => {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    api.posts
      .get({ id })
      .then((r) => {
        setPost(r.post);
        setComments(r.comments);
        document.title = `@${r.post.author.username}: ${r.post.text.slice(0, 60)} · ${APP_NAME}`;
      })
      .catch((e) => setError(errText(e)));
  }, [id]);

  const send = async () => {
    if (!text.trim() || busy || !post) return;
    setBusy(true);
    try {
      const c = await api.posts.comment({ id: post.id, text: text.trim() });
      setComments([...comments, c]);
      setPost({ ...post, comments: post.comments + 1 });
      setText("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeComment = async (c: Comment) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await api.posts.deleteComment({ id: c.id });
      setComments(comments.filter((x) => x.id !== c.id));
      if (post) setPost({ ...post, comments: post.comments - 1 });
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="space-y-5">
      <button onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))} className="btn-quiet">
        <Icon name="back" size={14} />
        Back
      </button>

      {error && <p className="font-mono text-sm text-red-300/80">{error}</p>}
      {!post && !error && <p className="font-mono text-sm text-gray-600">Loading…</p>}
      {post && <PostCard post={post} detail onChange={(n) => (n ? setPost(n) : navigate("/"))} />}

      {post && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500 px-1">
            {comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "No comments yet"}
          </h2>
          {comments.map((c) => (
            <div key={c.id} className="glass rounded-2xl px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <Link to={`/u/${c.author.username}`} className="min-w-0 truncate">
                  <span className="text-gray-100 text-sm font-medium">{c.author.displayName}</span>
                  <span className="ml-2 font-mono text-xs text-gray-500">@{c.author.username}</span>
                </Link>
                <span className="font-mono text-xs text-gray-500 shrink-0 flex items-center gap-3">
                  {timeAgo(c.createdAt)}
                  {me && (me.id === c.author.id || me.id === post.author.id) && (
                    <button onClick={() => removeComment(c)} className="hover:text-red-300" title="Delete">
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </span>
              </div>
              <p className="mt-1 text-gray-200 text-sm whitespace-pre-line break-words">{c.text}</p>
            </div>
          ))}

          {me ? (
            <div className="glass rounded-2xl px-4 py-3 space-y-2">
              <textarea
                className="field min-h-[70px] text-sm resize-y"
                placeholder="Add a comment"
                value={text}
                maxLength={COMMENT_MAX}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
                }}
              />
              <div className="flex items-center gap-4">
                <button onClick={send} disabled={busy || !text.trim()} className="btn">
                  <Icon name="comment" size={14} />
                  Comment
                </button>
                <span className="font-mono text-xs text-gray-600">{COMMENT_MAX - text.length}</span>
              </div>
            </div>
          ) : (
            me === null && (
              <p className="font-mono text-xs text-gray-500 px-1">
                <Link to={`/login?next=${encodeURIComponent(`/p/${id}`)}`} className="text-blue-300/90 hover:text-blue-200">
                  Sign in
                </Link>{" "}
                to comment.
              </p>
            )
          )}
        </section>
      )}
    </div>
  );
};

export default PostPage;
