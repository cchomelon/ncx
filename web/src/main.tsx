import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./style.css";

const root = document.querySelector("#app");
if (!root) throw new Error("ncx application root is missing");

createRoot(root).render(<App />);
