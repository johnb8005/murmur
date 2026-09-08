import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth";
import Layout from "./ui/layout";
import Timeline from "./ui/timeline";
import PostPage from "./ui/postpage";
import Profile from "./ui/profile";
import Login from "./ui/login";
import Settings from "./ui/settings";
import SharePage from "./ui/share";

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Timeline />} />
          <Route path="/p/:id" element={<PostPage />} />
          <Route path="/u/:username" element={<Profile />} />
          <Route path="/login" element={<Login />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/share" element={<SharePage />} />
          <Route path="*" element={<Timeline />} />
        </Routes>
      </Layout>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
