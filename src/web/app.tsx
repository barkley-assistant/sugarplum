import { createRoot } from "react-dom/client";
import { AppPage } from "./components/AppPage";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<AppPage />);
}