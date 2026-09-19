import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, errText } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME } from "../../shared/links";

const Login = () => {
  document.title = `Sign in · ${APP_NAME}`;
  const { me, signIn, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";

  const [mode, setMode] = useState<"in" | "up">(params.get("mode") === "up" ? "up" : "in");
  const [username, setUsername] = useState("");
  const [check, setCheck] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  useEffect(() => {
    if (me) navigate(next, { replace: true });
  }, [me, navigate, next]);

  // live availability check while typing a username for a new account
  useEffect(() => {
    if (mode !== "up" || !username.trim()) return setCheck(null);
    const t = setTimeout(() => api.auth.checkUsername({ username: username.trim() }).then(setCheck).catch(() => setCheck(null)), 300);
    return () => clearTimeout(t);
  }, [mode, username]);

  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      navigate(next, { replace: true });
    } catch (e) {
      const msg = errText(e);
      setError(/NotAllowedError|cancel|abort/i.test(msg) ? "Cancelled." : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-5">
      <div className="flex gap-6 px-1 font-mono text-sm">
        <button onClick={() => setMode("in")} className={mode === "in" ? "text-white" : "text-gray-500 hover:text-gray-300"}>
          Sign in
        </button>
        <button onClick={() => setMode("up")} className={mode === "up" ? "text-white" : "text-gray-500 hover:text-gray-300"}>
          Create account
        </button>
      </div>

      {!supported && <p className="font-mono text-xs text-yellow-300/80 px-1">This browser has no passkey support. Try a current Safari, Chrome, Edge or Firefox.</p>}

      {mode === "in" ? (
        <div className="glass rounded-3xl px-6 py-6 space-y-4">
          <p className="text-gray-300">Your passkey is your account: Face ID, Touch ID, Windows Hello or a security key.</p>
          <button onClick={() => go(() => signIn(username.trim() || undefined))} disabled={busy || !supported} className="btn">
            <Icon name="fingerprint" size={16} />
            {busy ? "Waiting for your passkey…" : "Sign in with passkey"}
          </button>
          <details className="text-gray-500">
            <summary className="cursor-pointer font-mono text-xs hover:text-gray-300">Passkey not offered? Type your username</summary>
            <input className="field mt-3 font-mono text-sm" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" />
          </details>
          <p className="font-mono text-xs text-gray-600">
            New device? On one where you are signed in, open your profile, tap "Add another device" and scan the QR code here. Or pick
            "use a phone or tablet" in the passkey prompt.
          </p>
        </div>
      ) : (
        <div className="glass rounded-3xl px-6 py-6 space-y-4">
          <p className="text-gray-300">Pick a username. No password, no email: your device's passkey signs you in. Already have an account? Add this device from Settings instead of creating a second one.</p>
          <div>
            <input
              className="field font-mono text-sm"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === "Enter" && check?.available) go(() => register(username.trim()));
              }}
            />
            <p className={`mt-2 font-mono text-xs ${!check ? "text-gray-600" : check.available ? "text-emerald-300/90" : "text-red-300/90"}`}>
              {!username.trim() ? "3 to 20 characters: letters, digits, underscore" : !check ? "checking…" : check.available ? `@${username.trim()} is free` : check.reason}
            </p>
          </div>
          <button onClick={() => go(() => register(username.trim()))} disabled={busy || !supported || !check?.available} className="btn">
            <Icon name="fingerprint" size={16} />
            {busy ? "Waiting for your passkey…" : "Create account with passkey"}
          </button>
        </div>
      )}

      {error && <p className="font-mono text-xs text-red-300/90 px-1">{error}</p>}
    </div>
  );
};

export default Login;
