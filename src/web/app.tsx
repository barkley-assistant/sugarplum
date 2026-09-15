import { createRoot } from "react-dom/client";
import { AppPage } from "./components/AppPage";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ToastProvider>
      <ConfirmProvider>
        <AppPage />
      </ConfirmProvider>
    </ToastProvider>,
  );
}