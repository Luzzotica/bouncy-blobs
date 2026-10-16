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
        {/* /c/CODE is the QR link (partii hosting); /p/CODE the same page;
            /controller/CODE is the old link, for QR codes already printed. */}
        <Route path="/c/:sessionId" element={<Controller />} />
        <Route path="/p/:sessionId" element={<Controller />} />
        <Route path="/controller/:sessionId" element={<Controller />} />
        <Route path="*" element={<Navigate to="/join" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
