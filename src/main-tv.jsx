import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import TvElogios from "./pages/TvElogios";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <TvElogios />
  </StrictMode>
);
