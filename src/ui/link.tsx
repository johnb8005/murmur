import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME, type Author } from "../../shared/links";

/**
 * Settings → "Add another device": mints a device link and shows it as a QR code (scan it with the
 * new phone) and as a URL to copy or share (AirDrop, a message to yourself). Valid ten minutes,
 * usable once; another click makes a fresh one.
 */
export const DeviceLinkCard = ({ onDone }: { onDone: () => void }) => {
  const [link, setLink] = useState<{ url: string; expiresAt: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const make = async () => {
    setError(null);
    setNote(null);
    try {
      const { token, expiresAt } = await api.auth.linkCreate();
      const url = `${window.location.origin}/link/${token}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: "#f3f4f6", light: "#00000000" } });
      setLink({ url, expiresAt, qr });
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    make();
  }, []);

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setNote("Link copied. It works once, for ten minutes.");
  };

  const share = async () => {
    if (!link) return;
    if (typeof navigator.share !== "function") return copy();
    try {
      await navigator.share({ title: `Add a device to ${APP_NAME}`, url: link.url });
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) setError(errText(e));
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4 space-y-3">
      <p className="text-sm text-gray-300">On the new device, scan this or open the link. It creates a passkey there for your account and signs it in.</p>
      {link && (
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <img src={link.qr} alt="QR code of the device link" width={180} height={180} className="rounded-lg shrink-0" />
          <div className="min-w-0 space-y-3 w-full">
            <code className="block break-all font-mono text-xs text-gray-400 select-all">{link.url}</code>
            <div className="flex flex-wrap gap-4">
              <button onClick={copy} className="btn-quiet">
                <Icon name="copy" size={14} />
                Copy link
              </button>
              <button onClick={share} className="btn-quiet">
                <Icon name="share" size={14} />
                Share
              </button>
              <button onClick={make} className="btn-quiet">
                <Icon name="refresh" size={14} />
                New link
              </button>
              <button onClick={onDone} className="btn-quiet">
                Done
              </button>
            </div>
            <p className="font-mono text-xs text-gray-600">Single use, expires {new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
          </div>
        </div>
      )}
      {note && <p className="font-mono text-xs text-emerald-300/90">{note}</p>}
      {error && <p className="font-mono text-xs text-red-300/90">{error}</p>}
    </div>
  );
};

/** /link/<token>, opened on the new device. */
const LinkDevice = () => {
  document.title = `Add this device · ${APP_NAME}`;
  const { token = "" } = useParams();
  const { me, linkDevice, signOut } = useAuth();
  const navigate = useNavigate();
  const [owner, setOwner] = useState<Author | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  useEffect(() => {
    setError(null);
    api.auth
      .linkInfo({ token })
      .then((r) => setOwner(r.user))
      .catch((e) => setError(errText(e)));
  }, [token]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      if (me && owner && me.id !== owner.id) await signOut();
      await linkDevice(token);
      navigate("/", { replace: true });
    } catch (e) {
      const msg = errText(e);
      setError(/NotAllowedError|cancel|abort/i.test(msg) ? "Cancelled. Try again, the link is still valid." : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-5">
      <div className="glass rounded-3xl px-6 py-6 space-y-4">
        <h1 className="text-2xl font-light tracking-tight">Add this device</h1>
        {error && !owner && (
          <>
            <p className="font-mono text-xs text-red-300/90">{error}</p>
            <Link to="/login" className="btn-quiet">
              <Icon name="fingerprint" size={14} />
              Sign in instead
            </Link>
          </>
        )}
        {owner && (
          <>
            <p className="text-gray-300">
              This link adds a passkey for <span className="text-white">{owner.displayName}</span>{" "}
              <span className="font-mono text-sm text-gray-500">@{owner.username}</span> to this device and signs it in.
            </p>
            {me && me.id !== owner.id && (
              <p className="font-mono text-xs text-yellow-300/80">You are signed in as @{me.username} here; continuing signs that account out on this device.</p>
            )}
            {!supported && <p className="font-mono text-xs text-yellow-300/80">This browser has no passkey support. Try a current Safari, Chrome, Edge or Firefox.</p>}
            <button onClick={add} disabled={busy || !supported} className="btn">
              <Icon name="fingerprint" size={16} />
              {busy ? "Waiting for your passkey…" : "Create a passkey on this device"}
            </button>
            {error && <p className="font-mono text-xs text-red-300/90">{error}</p>}
          </>
        )}
        {!owner && !error && <p className="font-mono text-sm text-gray-600">Checking the link…</p>}
      </div>
    </div>
  );
};

export default LinkDevice;
