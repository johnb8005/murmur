import React, { useEffect, useRef, useState } from "react";
import { api, errText } from "../api";
import { Icon } from "../icons";
import { POST_MAX, POST_NOUN, TAGS_MAX, parseTagList, postTags, type Post } from "../../shared/links";
import { IMAGE_TYPES, prepareImage, type PreparedImage } from "../image";
import { TagChip } from "./post";

interface Props {
  initial?: string;
  /** a picture handed over by the share sheet (see ui/share.tsx) */
  initialImage?: File | null;
  autoFocus?: boolean;
  onPosted: (post: Post) => void;
}

type Webhook = { id: string; name: string };

// which webhooks the composer last sent to, per device
const SLACK_PICK = "murmur.slack";
const savedPick = (): string[] | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SLACK_PICK) || "null");
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const savePick = (ids: string[]) => {
  try {
    localStorage.setItem(SLACK_PICK, JSON.stringify(ids));
  } catch {}
};

/**
 * The composer. Tags come from #hashtags in the text and/or the separate tag field (comma or space
 * separated); "Only me" keeps the murmur private to its author. One picture can ride along: picked
 * from the photo library or camera, shrunk in the browser (src/image.ts), uploaded with the post.
 * With Slack webhooks set up in settings, a public murmur can go to one or more channels as well.
 */
const Compose = ({ initial = "", initialImage = null, autoFocus = false, onPosted }: Props) => {
  const [text, setText] = useState(initial);
  const [tagText, setTagText] = useState("");
  const [showTags, setShowTags] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [toSlack, setToSlack] = useState(false);
  const [slackIds, setSlackIds] = useState<string[]>([]);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    api.slack
      .list()
      .then((hs) => {
        setWebhooks(hs);
        const kept = (savedPick() ?? []).filter((id) => hs.some((h) => h.id === id));
        setSlackIds(kept.length ? kept : hs.map((h) => h.id));
      })
      .catch(() => setWebhooks([]));
  }, []);

  const pickSlack = (id: string) =>
    setSlackIds((ids) => {
      const next = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
      savePick(next);
      return next;
    });

  const attach = async (file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    setPreparing(true);
    try {
      const prepared = await prepareImage(file);
      setImage((old) => {
        if (old) URL.revokeObjectURL(old.previewUrl);
        return prepared;
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  useEffect(() => {
    attach(initialImage);
  }, [initialImage]);

  const detach = () => {
    setImage((old) => {
      if (old) URL.revokeObjectURL(old.previewUrl);
      return null;
    });
  };

  const left = POST_MAX - text.length;
  const typedTags = parseTagList(tagText);
  const tags = postTags(text, typedTags);
  const tooMany = postTags(text, []).length + typedTags.length > TAGS_MAX;
  const slackTargets = toSlack && !isPrivate ? slackIds.filter((id) => webhooks.some((h) => h.id === id)) : [];
  const canPost = (!!text.trim() || !!image) && left >= 0 && !busy && !preparing && (!toSlack || isPrivate || slackTargets.length > 0);

  const submit = async () => {
    if (!canPost) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.posts.create({
        text: text.trim(),
        tags: typedTags,
        private: isPrivate,
        ...(slackTargets.length ? { slack: slackTargets } : {}),
        ...(image ? { image: image.file, imageWidth: image.width, imageHeight: image.height } : {}),
      });
      const notes: string[] = [];
      const failed = Object.entries(r.previews).filter(([, e]) => e);
      if (failed.length) notes.push(`Preview unavailable for ${failed.map(([u]) => u).join(", ")}.`);
      const unsent = r.slack.filter((s) => s.error);
      if (unsent.length) notes.push(`Not sent to Slack: ${unsent.map((s) => `${s.name} (${s.error})`).join(", ")}.`);
      if (notes.length) setNote(`Posted. ${notes.join(" ")}`);
      setText("");
      setTagText("");
      detach();
      onPosted(r.post);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const openTags = () => {
    setShowTags(true);
    setTimeout(() => tagRef.current?.focus(), 0);
  };

  return (
    <div className="glass rounded-3xl px-5 py-4 md:px-6 md:py-5 space-y-3">
      <textarea
        ref={ref}
        className="field min-h-[110px] leading-relaxed resize-y"
        placeholder="Something worth sharing? Paste a link, say why. #tags welcome."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        maxLength={POST_MAX * 2}
        onPaste={(e) => {
          const file = [...e.clipboardData.files].find((f) => IMAGE_TYPES.includes(f.type));
          if (file) {
            e.preventDefault();
            attach(file);
          }
        }}
      />

      {image && (
        <div className="relative inline-block max-w-full">
          <img
            src={image.previewUrl}
            alt=""
            width={image.width}
            height={image.height}
            className="block max-h-72 w-auto max-w-full rounded-2xl border border-white/10 object-contain bg-black/40"
          />
          <button
            onClick={detach}
            className="absolute top-2 right-2 rounded-full bg-black/70 p-1.5 text-gray-200 hover:bg-black/90 hover:text-white"
            title="Remove picture"
            aria-label="Remove picture"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {(showTags || tagText) && (
        <div className="flex items-center gap-2">
          <Icon name="hash" size={14} className="text-gray-500 shrink-0" />
          <input
            ref={tagRef}
            className="field py-2 text-sm font-mono"
            placeholder="tags, comma or space separated"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            aria-label="Tags"
          />
        </div>
      )}

      {toSlack && !isPrivate && webhooks.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Slack channels">
          <Icon name="send" size={14} className="text-gray-500 shrink-0 mr-0.5" />
          {webhooks.map((h) => (
            <button
              key={h.id}
              onClick={() => pickSlack(h.id)}
              role="checkbox"
              aria-checked={slackIds.includes(h.id)}
              className={`rounded-full border px-2.5 py-0.5 font-mono text-xs ${slackIds.includes(h.id) ? "border-sky-300/40 bg-sky-300/10 text-sky-200" : "border-white/10 text-gray-500 hover:text-gray-300"}`}
            >
              {h.name}
            </button>
          ))}
        </div>
      )}

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Labels">
          {tags.map((t) => (
            <TagChip key={t} tag={t} />
          ))}
          {tooMany && <span className="font-mono text-xs text-yellow-300/80">first {TAGS_MAX} kept</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button onClick={submit} disabled={!canPost} className="btn">
          <Icon name={isPrivate ? "lock" : "share"} size={14} />
          {busy ? "Posting…" : isPrivate ? "Murmur to myself" : "Murmur"}
        </button>
        <span className={`font-mono text-xs ${left < 0 ? "text-red-300" : left < 50 ? "text-yellow-300/80" : "text-gray-600"}`}>{left}</span>
        <div className="ml-auto flex items-center gap-4">
          <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(",")} className="hidden" onChange={(e) => attach(e.target.files?.[0])} aria-label="Picture file" />
          <button onClick={() => fileRef.current?.click()} disabled={preparing || busy} className={`btn-quiet ${image ? "text-emerald-300/90" : ""}`} title={image ? "Replace the picture" : "Attach a picture"}>
            <Icon name="image" size={14} />
            {preparing ? "Reading…" : image ? "Picture" : "Photo"}
          </button>
          {!showTags && !tagText && (
            <button onClick={openTags} className="btn-quiet" title="Add tags">
              <Icon name="hash" size={14} />
              Tags
            </button>
          )}
          {webhooks.length > 0 && (
            <button
              onClick={() => setToSlack(!toSlack)}
              disabled={isPrivate}
              className={`btn-quiet ${toSlack && !isPrivate ? "text-sky-300/90 hover:text-sky-200" : ""}`}
              role="switch"
              aria-checked={toSlack && !isPrivate}
              title={
                isPrivate
                  ? `Private ${POST_NOUN}s stay off Slack`
                  : toSlack
                    ? `Also sent to ${webhooks.filter((h) => slackTargets.includes(h.id)).map((h) => h.name).join(", ") || "no channel yet: pick one"}`
                    : "Also send it to Slack"
              }
            >
              <Icon name="send" size={14} />
              Slack
            </button>
          )}
          <button
            onClick={() => setPrivate(!isPrivate)}
            className={`btn-quiet ${isPrivate ? "text-amber-300/90 hover:text-amber-200" : ""}`}
            role="switch"
            aria-checked={isPrivate}
            title={isPrivate ? `Only you will see this ${POST_NOUN}` : `Everyone sees this ${POST_NOUN}; click to keep it to yourself`}
          >
            <Icon name={isPrivate ? "lock" : "globe"} size={14} />
            {isPrivate ? "Only me" : "Everyone"}
          </button>
        </div>
        {busy && <span className="font-mono text-xs text-gray-500">capturing preview…</span>}
      </div>
      {error && <p className="font-mono text-xs text-red-300/90">{error}</p>}
      {note && <p className="font-mono text-xs text-yellow-300/80">{note}</p>}
    </div>
  );
};

export default Compose;
