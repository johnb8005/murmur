import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import Layout from "./ui/layout";
import Timeline from "./ui/timeline";
import PostPage from "./ui/postpage";
import Profile from "./ui/profile";
import Login from "./ui/login";
import Settings from "./ui/settings";
import SharePage from "./ui/share";
import LinkDevice from "./ui/link";

/** The network is private: every page but sign-in and device links needs an account. */
const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const { me } = useAuth();
  const location = useLocation();
  if (me === undefined) return <p className="font-mono text-sm text-gray-600">Loading…</p>;
  if (me === null) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
};

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/link/:token" element={<LinkDevice />} />
          <Route path="/p/:id" element={<RequireAuth><PostPage /></RequireAuth>} />
          <Route path="/u/:username" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
          <Route path="/share" element={<RequireAuth><SharePage /></RequireAuth>} />
          <Route path="*" element={<RequireAuth><Timeline /></RequireAuth>} />
        </Routes>
      </Layout>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
