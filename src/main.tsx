import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/ios26.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
