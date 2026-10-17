import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Controller from "./pages/Controller";
import JoinLobby from "./pages/JoinLobby";
import BuyResult from "./pages/BuyResult";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/join" element={<JoinLobby />} />
        {/* Stripe Checkout's return pages for the in-game buy screen
            (success_url / cancel_url; docs/BuyFlow.md). */}
        <Route path="/paid" element={<BuyResult kind="paid" />} />
        <Route path="/cancelled" element={<BuyResult kind="cancelled" />} />
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
