import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api, deviceName, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME } from "../../shared/links";
import { DeviceLinkCard, useDeviceLink } from "./link";

type Passkey = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null };
type Feed = { token: string; rss: string; json: string };

const Settings = () => {
  document.title = `Settings · ${APP_NAME}`;
  const { me, refresh, signOut } = useAuth();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // profile form
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [check, setCheck] = useState<{ available: boolean; reason: string | null } | null>(null);

  const load = useCallback(() => api.auth.passkeys().then(setPasskeys).catch((e) => setMsg({ ok: false, text: errText(e) })), []);
  const linking = useDeviceLink(load);

  useEffect(() => {
    if (me) {
      load();
      api.auth.feed().then(setFeed).catch(() => setFeed(null));
      setUsername(me.username);
      setDisplayName(me.displayName);
    }
  }, [me, load]);

  // live availability check while typing a new username
  const usernameChanged = !!me && username.trim().toLowerCase() !== me.username;
  useEffect(() => {
    if (!usernameChanged || !username.trim()) return setCheck(null);
    const t = setTimeout(() => api.auth.checkUsername({ username: username.trim() }).then(setCheck).catch(() => setCheck(null)), 300);
    return () => clearTimeout(t);
  }, [username, usernameChanged]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const t = await fn();
      if (t) setMsg({ ok: true, text: t });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const profileDirty = !!me && (usernameChanged || displayName.trim() !== me.displayName);
  const profileValid = !usernameChanged || check?.available === true;

  const saveProfile = () =>
    run(async () => {
      if (!me) return;
      const changes: { username?: string; displayName?: string } = {};
      if (usernameChanged) changes.username = username.trim();
      if (displayName.trim() !== me.displayName) changes.displayName = displayName.trim();
      if (usernameChanged && !confirm(`Change your username to @${username.trim().toLowerCase()}? Links to /u/${me.username} will stop working.`)) return;
      const { user } = await api.auth.updateProfile(changes);
      await refresh();
      return `Saved. You are @${user.username}.`;
    });

  const add = () =>
    run(async () => {
      const { challengeId, options } = await api.auth.addPasskeyOptions();
      const response = await startRegistration({ optionsJSON: options });
      await api.auth.addPasskey({ challengeId, response, deviceName: deviceName() });
      await load();
      return "Passkey added.";
    });

  const remove = (id: string) =>
    run(async () => {
      if (!confirm("Remove this passkey?")) return;
      await api.auth.removePasskey({ id });
      await load();
    });

  const copy = (text: string, what: string) => run(async () => {
    await navigator.clipboard.writeText(text);
    return `${what} copied.`;
  });

  if (!me) return null;

  return (
    <div className="max-w-md mx-auto space-y-5">
      <header className="px-1">
        <h1 className="text-3xl font-light tracking-tight">{me.displayName}</h1>
        <Link to={`/u/${me.username}`} className="font-mono text-sm text-gray-500 hover:text-gray-300">
          @{me.username}
        </Link>
      </header>

      <section className="glass rounded-3xl px-6 py-5 space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">Profile</h2>
        <label className="block">
          <span className="font-mono text-xs text-gray-500">Display name</span>
          <input className="field mt-1" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="block">
          <span className="font-mono text-xs text-gray-500">Username</span>
          <input
            className="field mt-1 font-mono text-sm"
            value={username}
            maxLength={20}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
          <p className={`mt-1.5 font-mono text-xs ${!usernameChanged ? "text-gray-600" : !check ? "text-gray-600" : check.available ? "text-emerald-300/90" : "text-red-300/90"}`}>
            {!usernameChanged
              ? "3 to 20 characters: letters, digits, underscore. Changing it changes your profile link."
              : !username.trim()
                ? "3 to 20 characters: letters, digits, underscore"
                : !check
                  ? "checking…"
                  : check.available
                    ? `@${username.trim()} is free`
                    : check.reason}
          </p>
        </label>
        <button onClick={saveProfile} disabled={busy || !profileDirty || !profileValid} className="btn">
          <Icon name="user" size={14} />
          Save
        </button>
      </section>

      <section className="glass rounded-3xl px-6 py-5 space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">Passkeys</h2>
        {passkeys.map((k) => (
          <div key={k.id} className="flex items-center justify-between gap-4 font-mono text-xs">
            <span className="text-gray-300 truncate">
              <Icon name="key" size={12} className="inline mr-2 opacity-60" />
              {k.name || k.id.slice(0, 12)}
              <span className="text-gray-600"> · added {k.createdAt.slice(0, 10)}{k.lastUsedAt ? `, used ${k.lastUsedAt.slice(0, 10)}` : ""}</span>
            </span>
            <button onClick={() => remove(k.id)} disabled={busy || passkeys.length < 2} className="text-gray-600 hover:text-red-300 disabled:opacity-30 shrink-0" title={passkeys.length < 2 ? "Keep at least one" : "Remove"}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-5 pt-1">
          <button onClick={add} disabled={busy} className="btn-quiet">
            <Icon name="plus" size={14} />
            Add this device
          </button>
          <button onClick={linking.make} disabled={busy || linking.busy} className="btn-quiet">
            <Icon name="qr" size={14} />
            {linking.busy ? "Waiting for your passkey…" : "Add another device"}
          </button>
        </div>
        {linking.open && <DeviceLinkCard state={linking} />}
        <p className="font-mono text-xs text-gray-600">
          One account, many devices: each one you use gets its own passkey. "Add another device" asks for your passkey here, then shows a
          QR code and a link to open on the new phone or laptop; it registers a passkey there and signs it in. Passkeys synced by iCloud
          Keychain or Google Password Manager need no extra step.
        </p>
      </section>

      <section className="glass rounded-3xl px-6 py-5 space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">Feeds</h2>
        <p className="font-mono text-xs text-gray-600">
          The timeline is for members only, so your feed URLs carry a secret token. Paste one into your reader; keep it to yourself.
        </p>
        {feed && (
          <div className="flex flex-wrap gap-5">
            <button onClick={() => copy(feed.rss, "RSS URL")} disabled={busy} className="btn-quiet">
              <Icon name="rss" size={14} />
              Copy RSS URL
            </button>
            <button onClick={() => copy(feed.json, "JSON Feed URL")} disabled={busy} className="btn-quiet">
              <Icon name="copy" size={14} />
              Copy JSON Feed URL
            </button>
          </div>
        )}
      </section>

      <section className="glass rounded-3xl px-6 py-5 space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-widest text-gray-500">Account</h2>
        <button onClick={() => run(async () => void (await signOut()))} disabled={busy} className="btn-quiet">
          <Icon name="logout" size={14} />
          Sign out
        </button>
      </section>

      {msg && <p className={`font-mono text-xs px-1 ${msg.ok ? "text-emerald-300/90" : "text-red-300/90"}`}>{msg.text}</p>}
    </div>
  );
};

export default Settings;
