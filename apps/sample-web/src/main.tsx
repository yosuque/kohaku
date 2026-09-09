import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./theme/app-theme.css";
import { ThemeModeProvider } from "./theme/mode.js";

// Language state is a module store (i18n/lang.ts) — no provider needed.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeModeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeModeProvider>
  </StrictMode>,
);
