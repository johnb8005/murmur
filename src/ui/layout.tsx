import React, { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../auth";
import { Icon } from "../icons";
import { APP_NAME } from "../../shared/links";

/** Chrome's install prompt, if the browser offered one and the app isn't installed yet. */
const useInstallPrompt = () => {
  const [prompt, setPrompt] = useState<(Event & { prompt: () => Promise<unknown> }) | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as Event & { prompt: () => Promise<unknown> });
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return prompt;
};

const Layout = ({ children }: { children: React.ReactNode }) => {
  const { me } = useAuth();
  const install = useInstallPrompt();

  return (
    <>
      <div className="aurora" />
      <div className="relative z-10 max-w-xl mx-auto px-4 pb-16">
        <header className="flex items-center justify-between py-5 md:py-7">
          <Link to="/" className="flex items-center gap-2.5 group">
            <img src="/icon.svg" alt="" className="w-7 h-7 rounded-lg" />
            <span className="text-2xl font-light tracking-tight group-hover:text-white text-gray-100">{APP_NAME}</span>
          </Link>
          <nav className="flex items-center gap-4 text-gray-500">
            {install && (
              <button onClick={() => install.prompt()} className="btn-quiet" title="Install the app">
                <Icon name="plus" size={16} />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}
            <a href="/feed.xml" className="hover:text-orange-300 transition-colors" title="RSS">
              <Icon name="rss" size={18} />
            </a>
            {me === null && (
              <NavLink to="/login" className="btn-quiet">
                <Icon name="fingerprint" size={16} />
                Sign in
              </NavLink>
            )}
            {me && (
              <>
                <NavLink to={`/u/${me.username}`} className="btn-quiet" title="Your posts">
                  <Icon name="user" size={16} />
                  <span className="hidden sm:inline">@{me.username}</span>
                </NavLink>
                <NavLink to="/settings" className="hover:text-gray-200 transition-colors" title="Settings">
                  <Icon name="settings" size={18} />
                </NavLink>
              </>
            )}
          </nav>
        </header>
        <main>{children}</main>
        <footer className="mt-16 text-center text-gray-600 text-xs font-mono">
          {APP_NAME} · <a href="/feed.xml" className="hover:text-gray-400">RSS</a> · <a href="/feed.json" className="hover:text-gray-400">JSON Feed</a>
        </footer>
      </div>
    </>
  );
};

export default Layout;
