import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api, deviceName, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME } from "../../shared/links";

type Passkey = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null };

const Settings = () => {
  document.title = `Settings · ${APP_NAME}`;
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => api.auth.passkeys().then(setPasskeys).catch((e) => setMsg({ ok: false, text: errText(e) })), []);

  useEffect(() => {
    if (me === null) navigate("/login?next=/settings", { replace: true });
    if (me) load();
  }, [me, navigate, load]);

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
        <div className="flex gap-5 pt-1">
          <button onClick={add} disabled={busy} className="btn-quiet">
            <Icon name="plus" size={14} />
            Add this device
          </button>
        </div>
        <p className="font-mono text-xs text-gray-600">Add a passkey on each device you use, or sync them through iCloud Keychain / Google Password Manager.</p>
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
