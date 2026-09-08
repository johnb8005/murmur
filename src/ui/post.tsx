import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errText, timeAgo } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { host, APP_NAME, type Post, type Preview } from "../../shared/links";

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Post text with URLs turned into links and line breaks kept. */
export const Text = ({ text, className = "" }: { text: string; className?: string }) => (
  <p className={`text-gray-100 leading-relaxed whitespace-pre-line break-words ${className}`}>
    {text.split(URL_RE).map((part, i) =>
      URL_RE.test(part) ? (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-300/90 hover:text-blue-200 break-all" onClick={(e) => e.stopPropagation()}>
          {part.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      )
    )}
  </p>
);

/** Twitter-style link card: image, title, description, host. */
export const PreviewCard = ({ url, preview }: { url: string; preview: Preview | null }) => (
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => e.stopPropagation()}
    className="mt-3 block rounded-2xl overflow-hidden glass glass-hover transition-all duration-300"
  >
    {preview?.image && (
      <div className="aspect-[2/1] bg-black/40 overflow-hidden">
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.currentTarget.parentElement as HTMLElement).style.display = "none";
          }}
        />
      </div>
    )}
    <div className="px-4 py-3">
      <div className="text-gray-100 font-medium leading-snug line-clamp-2">{preview?.title || url.replace(/^https?:\/\/(www\.)?/, "")}</div>
      {preview?.description && <div className="mt-1 text-sm text-gray-400 leading-snug line-clamp-2">{preview.description}</div>}
      <div className="mt-2 font-mono text-xs text-gray-500 truncate flex items-center gap-1.5">
        <Icon name="link" size={12} className="opacity-60" />
        {preview?.siteName && preview.siteName !== host(url) ? `${preview.siteName} · ` : ""}
        {host(url)}
      </div>
    </div>
  </a>
);

/** Web Share API with a clipboard fallback. Returns what happened, for a toast. */
export const sharePost = async (post: Post): Promise<"shared" | "copied" | null> => {
  const url = `${window.location.origin}/p/${post.id}`;
  const data = { title: `@${post.author.username} on ${APP_NAME}`, text: post.text, url };
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return null;
    }
  }
  await navigator.clipboard.writeText(url);
  return "copied";
};

interface Props {
  post: Post;
  /** the post page renders everything; the timeline links to it */
  detail?: boolean;
  onChange?: (post: Post | null) => void;
}

export const PostCard = ({ post, detail = false, onChange }: Props) => {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 1800);
  };

  const like = async () => {
    if (!me) return navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    // optimistic
    onChange?.({ ...post, likedByMe: !post.likedByMe, likes: post.likes + (post.likedByMe ? -1 : 1) });
    try {
      const r = await api.posts.like({ id: post.id });
      onChange?.({ ...post, likedByMe: r.liked, likes: r.likes });
    } catch (e) {
      onChange?.(post);
      flash(errText(e));
    }
  };

  const share = async () => {
    try {
      const r = await sharePost(post);
      if (r === "copied") flash("Link copied");
    } catch (e) {
      flash(errText(e));
    }
  };

  const remove = async () => {
    if (!confirm("Delete this post?")) return;
    setBusy(true);
    try {
      await api.posts.delete({ id: post.id });
      onChange?.(null);
      if (detail) navigate("/");
    } catch (e) {
      flash(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    if (!detail) navigate(`/p/${post.id}`);
  };

  return (
    <article
      id={post.id}
      onClick={open}
      className={`glass rounded-3xl px-5 py-4 md:px-6 md:py-5 transition-all duration-300 ${detail ? "" : "glass-hover cursor-pointer"}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Link to={`/u/${post.author.username}`} onClick={(e) => e.stopPropagation()} className="min-w-0 truncate group">
          <span className="text-gray-100 font-medium group-hover:text-white">{post.author.displayName}</span>
          <span className="ml-2 font-mono text-xs text-gray-500">@{post.author.username}</span>
        </Link>
        <Link to={`/p/${post.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-gray-500 hover:text-gray-300 shrink-0" title={new Date(post.createdAt).toLocaleString()}>
          {timeAgo(post.createdAt)}
        </Link>
      </div>

      <div className="mt-2">
        <Text text={post.text} className={detail ? "text-lg" : ""} />
      </div>
      {post.link && <PreviewCard url={post.link} preview={post.preview} />}
      {post.ref && post.refPreview?.title && (
        <a href={post.ref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="mt-2 inline-flex items-center gap-1.5 max-w-full font-mono text-xs text-gray-500 hover:text-gray-300">
          <Icon name="external" size={12} className="opacity-60 shrink-0" />
          <span className="truncate">{post.refPreview.title}</span>
          <span className="text-gray-600 shrink-0">{host(post.ref)}</span>
        </a>
      )}

      <div className="mt-3 flex items-center gap-6 text-gray-500 font-mono text-xs" onClick={(e) => e.stopPropagation()}>
        <button onClick={like} className={`btn-quiet ${post.likedByMe ? "text-pink-400 hover:text-pink-300" : "hover:text-pink-300"}`} title={post.likedByMe ? "Unlike" : "Like"}>
          <Icon name="heart" size={16} filled={post.likedByMe} />
          {post.likes > 0 && post.likes}
        </button>
        <Link to={`/p/${post.id}`} className="btn-quiet hover:text-blue-300" title="Comments">
          <Icon name="comment" size={16} />
          {post.comments > 0 && post.comments}
        </Link>
        <button onClick={share} className="btn-quiet hover:text-emerald-300" title="Share">
          <Icon name="share" size={16} />
        </button>
        {me?.id === post.author.id && (
          <button onClick={remove} disabled={busy} className="btn-quiet hover:text-red-300 ml-auto" title="Delete">
            <Icon name="trash" size={16} />
          </button>
        )}
        {toast && <span className="text-emerald-300/90 ml-auto">{toast}</span>}
      </div>
    </article>
  );
};
