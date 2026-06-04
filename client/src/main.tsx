import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@fontsource/sora/400.css";
import "@fontsource/sora/600.css";
import "@fontsource/sora/800.css";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Register service worker for PWA push notifications
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // SW registration failed — push notifications unavailable
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
