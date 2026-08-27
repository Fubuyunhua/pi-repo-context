import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRepoContext } from "../src/extension.js";

export default function repoContextExtension(pi: ExtensionAPI): void {
  registerRepoContext(pi);
}
