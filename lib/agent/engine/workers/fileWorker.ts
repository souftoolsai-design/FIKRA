/**
 * SoufAI Agent Engine - Specialized File Worker
 * 
 * Manages atomic filesystem operations, structural integrity,
 * import path updates, and safe file indexing within the workspace.
 */

import { EngineExecutionContext } from "../types";
import { GlobalToolRegistry } from "../toolRegistry";
import { SandboxManager } from "@/lib/sandbox/sandboxManager";

export interface FileWorkerInput {
  action: "read" | "create" | "edit" | "delete" | "search" | "list";
  filePath?: string;
  content?: string;
  pattern?: string;
}

export interface FileWorkerResult {
  success: boolean;
  data?: any;
  error?: string;
}

export async function runFileWorker(
  input: FileWorkerInput,
  ctx: EngineExecutionContext
): Promise<FileWorkerResult> {
  const toolName =
    input.action === "read"
      ? "read_file"
      : input.action === "create"
      ? "create_file"
      : input.action === "edit"
      ? "edit_file"
      : input.action === "delete"
      ? "delete_file"
      : "search_files";

  const tool = GlobalToolRegistry.get(toolName);
  if (!tool) {
    return { success: false, error: `File tool '${toolName}' not registered.` };
  }

  const res = await tool.execute(
    {
      filePath: input.filePath,
      content: input.content,
      pattern: input.pattern,
    },
    ctx
  );

  return {
    success: res.success,
    data: res.data,
    error: res.error,
  };
}
