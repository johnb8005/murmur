import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import QRCode from "qrcode";
import { api, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME, type Author } from "../../shared/links";

type Passkey = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null };

interface LinkState {
  url: string;
  expiresAt: string;
  qr: string;
  /** passkeys the account had when the link was made: a new one means the other device is in */
  before: Set<string>;
}

/**
 * "Add another device", from your profile or Settings. `make` runs in the click handler so the
 * passkey prompt keeps its user gesture: it asks for a passkey on this device (proof it's you, a
 * session cookie alone is not enough), then mints a device link and shows it as a QR code to scan
 * with the new phone, or as a URL to copy or share. Valid ten minutes, usable once. While the link
 * is on screen the account's passkeys are polled, so the card can say when the other device is in.
 */
export const useDeviceLink = (onAdded?: (passkey: Passkey) => void) => {
  const { createDeviceLink } = useAuth();
  const [link, setLink] = useState<LinkState | null>(null);
  const [added, setAdded] = useState<Passkey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const [{ token, expiresAt }, passkeys] = await Promise.all([createDeviceLink(), api.auth.passkeys()]);
      const url = `${window.location.origin}/link/${token}`;
      const qr = await QRCode.toDataURL(url, { margin: 2, width: 240, errorCorrectionLevel: "M", color: { dark: "#0a0a0f", light: "#ffffff" } });
      setLink({ url, expiresAt, qr, before: new Set(passkeys.map((k) => k.id)) });
    } catch (e) {
      const msg = errText(e);
      setError(/NotAllowedError|cancel|abort/i.test(msg) ? "Cancelled: adding a device starts with your passkey on this one." : msg);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setLink(null);
    setAdded(null);
    setError(null);
  };

  useEffect(() => {
    if (!link || added) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.parse(link.expiresAt) < Date.now()) {
        setLink(null);
        setError("That link expired. Make a new one.");
        return;
      }
      try {
        const fresh = (await api.auth.passkeys()).find((k) => !link.before.has(k.id));
        if (fresh && !stopped) {
          setAdded(fresh);
          onAdded?.(fresh);
        }
      } catch {}
    };
    const timer = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [link, added]);

  return { link, added, busy, error, make, close, open: !!(link || error || added) };
};

export const DeviceLinkCard = ({ state }: { state: ReturnType<typeof useDeviceLink> }) => {
  const { link, added, busy, error, make, close } = state;
  const [note, setNote] = useState<string | null>(null);

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
      if (!(e instanceof Error && e.name === "AbortError")) setNote(errText(e));
    }
  };

  if (added) {
    return (
      <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/5 px-4 py-4 space-y-3">
        <p className="text-sm text-emerald-200/90 flex items-center gap-2">
          <Icon name="check" size={16} />
          New device added: <span className="font-mono text-xs">{added.name || added.id.slice(0, 12)}</span>
        </p>
        <p className="font-mono text-xs text-gray-500">It has its own passkey now and is signed in. The link is spent.</p>
        <div className="flex flex-wrap gap-4">
          <button onClick={make} disabled={busy} className="btn-quiet">
            <Icon name="qr" size={14} />
            Add one more
          </button>
          <button onClick={close} className="btn-quiet">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4 space-y-3">
      {link && (
        <>
          <p className="text-sm text-gray-300">On the new device, scan this or open the link. It creates a passkey there for your account and signs it in.</p>
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <img src={link.qr} alt="QR code of the device link" width={200} height={200} className="rounded-xl shrink-0 bg-white" />
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
                <button onClick={make} disabled={busy} className="btn-quiet">
                  <Icon name="refresh" size={14} />
                  New link
                </button>
                <button onClick={close} className="btn-quiet">
                  Done
                </button>
              </div>
              <p className="font-mono text-xs text-gray-600">
                Single use, expires {new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Waiting for the other device…
              </p>
            </div>
          </div>
        </>
      )}
      {!link && error && (
        <div className="flex flex-wrap items-center gap-4">
          <p className="font-mono text-xs text-red-300/90">{error}</p>
          <button onClick={make} disabled={busy} className="btn-quiet">
            <Icon name="fingerprint" size={14} />
            {busy ? "Waiting for your passkey…" : "Try again"}
          </button>
          <button onClick={close} className="btn-quiet">
            Done
          </button>
        </div>
      )}
      {note && <p className="font-mono text-xs text-emerald-300/90">{note}</p>}
      {link && error && <p className="font-mono text-xs text-red-300/90">{error}</p>}
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
