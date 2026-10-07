import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Controller from "./pages/Controller";
import JoinLobby from "./pages/JoinLobby";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/join" element={<JoinLobby />} />
        <Route path="/controller/:sessionId" element={<Controller />} />
        <Route path="*" element={<Navigate to="/join" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
