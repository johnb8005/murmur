import React, { useEffect, useRef, useState } from "react";
import { api, errText } from "../api";
import { Icon } from "../icons";
import { POST_MAX, type Post } from "../../shared/links";

interface Props {
  initial?: string;
  autoFocus?: boolean;
  onPosted: (post: Post) => void;
}

const Compose = ({ initial = "", autoFocus = false, onPosted }: Props) => {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const left = POST_MAX - text.length;

  const submit = async () => {
    if (!text.trim() || left < 0 || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.posts.create({ text: text.trim() });
      const failed = Object.entries(r.previews).filter(([, e]) => e);
      if (failed.length) setNote(`Posted. Preview unavailable for ${failed.map(([u]) => u).join(", ")}.`);
      setText("");
      onPosted(r.post);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass rounded-3xl px-5 py-4 md:px-6 md:py-5 space-y-3">
      <textarea
        ref={ref}
        className="field min-h-[110px] leading-relaxed resize-y"
        placeholder="Something worth sharing? Paste a link, say why."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
        maxLength={POST_MAX * 2}
      />
      <div className="flex items-center gap-4">
        <button onClick={submit} disabled={busy || !text.trim() || left < 0} className="btn">
          <Icon name="share" size={14} />
          {busy ? "Posting…" : "Post"}
        </button>
        <span className={`font-mono text-xs ${left < 0 ? "text-red-300" : left < 50 ? "text-yellow-300/80" : "text-gray-600"}`}>{left}</span>
        {busy && <span className="font-mono text-xs text-gray-500">capturing preview…</span>}
      </div>
      {error && <p className="font-mono text-xs text-red-300/90">{error}</p>}
      {note && <p className="font-mono text-xs text-yellow-300/80">{note}</p>}
    </div>
  );
};

export default Compose;
