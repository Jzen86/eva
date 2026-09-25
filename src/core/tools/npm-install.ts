import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.js";
import { requireApproval, registerApprovalApplier } from "../pending.js";

const execAsync = promisify(exec);

export const npmInstallTool: Tool = {
  name: "npm_install",
  description:
    "Install an npm package on the server. Installing a package runs its install " +
    "scripts, so this is NOT applied on request: the request is parked and the owner " +
    "approves it with /yes. If you get 'Жду подтверждения', nothing was installed — " +
    "tell the owner which package and why, and do not retry.",
  parameters: [
    {
      name: "package_name",
      type: "string",
      description: "The npm package name to install (e.g. 'lodash')",
      required: true,
    },
    {
      name: "reason",
      type: "string",
      description: "One line on why this package is needed, shown to the owner on the approval line",
    },
  ],

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const packageName = params.package_name;
    if (typeof packageName !== "string" || !packageName.trim()) {
      return {
        success: false,
        output: "Missing required parameter: package_name",
        error: "missing_param",
      };
    }

    const name = packageName.trim();

    // Basic validation: reject shell meta-characters to prevent injection.
    if (/[;&|`$(){}[\]<>!#]/.test(name)) {
      return {
        success: false,
        output: `Invalid package name: ${name}`,
        error: "invalid_name",
      };
    }

    /**
     * An npm install runs whatever the package's install scripts say, as the
     * user running the bot. A name the model invented, or one a page it read
     * suggested, is arbitrary code execution on the server. The old version
     * declared `requiresConfirmation: true` and trusted a `betsy-` prefix for
     * the rest — and nothing anywhere read that flag, so nothing was
     * confirmed. It is now an actual gate.
     */
    const approval = requireApproval(params, "npm_install", {
      summary: `установить пакет ${name}`,
      reason: typeof params.reason === "string" ? params.reason : "",
      args: { package_name: name },
    });
    if (approval) return approval;

    return doInstall(name);
  },
};

/** The install itself, shared with the approval flow. */
async function doInstall(name: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(`npm install ${name}`, {
      timeout: 120_000,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { success: true, output: output || `Installed ${name}.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `Failed to install ${name}: ${msg}`,
      error: "install_failed",
    };
  }
}

// How the install runs once the owner has said yes.
registerApprovalApplier("npm_install", async (args) => {
  const name = typeof args.package_name === "string" ? args.package_name : "";
  if (!name) return { success: false, output: "", error: "empty package_name" };
  return doInstall(name);
});
