import { createRoot } from "react-dom/client";
import { Login } from "./components/Login";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Login />);
}