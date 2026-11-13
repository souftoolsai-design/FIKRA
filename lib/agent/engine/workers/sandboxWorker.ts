/**
 * SoufAI Agent Engine - Specialized Runtime / Sandbox Worker
 * 
 * Manages isolated Linux container lifecycles, runs sanitized commands,
 * controls previews, streams logs, and enforces security constraints.
 */

import { EngineExecutionContext } from "../types";
import { SandboxManager } from "@/lib/sandbox/sandboxManager";
import { NativeSandboxInstance } from "@/lib/sandbox/nativeSandbox";

export interface SandboxWorkerInput {
  action: "create" | "run_command" | "start_preview" | "capture_screenshot" | "get_status" | "stop";
  command?: string;
  projectName?: string;
  framework?: string;
  timeoutMs?: number;
}

export interface SandboxWorkerResult {
  success: boolean;
  data?: any;
  error?: string;
}

export async function runSandboxWorker(
  input: SandboxWorkerInput,
  ctx: EngineExecutionContext
): Promise<SandboxWorkerResult> {
  if (input.action === "create") {
    const sbx = await SandboxManager.createSandbox({
      userId: ctx.userId,
      projectId: ctx.projectId || "p_default",
      projectName: input.projectName || "SoufTools App",
      framework: input.framework || "react_nextjs",
    });
    ctx.sandboxId = sbx.id;
    await ctx.emitEvent("sandbox.created", `إنشاء بيئة Sandbox المعزولة (${sbx.id})`, {
      agentWorker: "sandbox",
      status: "completed",
      payload: { sandboxId: sbx.id, port: sbx.port },
    });
    return { success: true, data: { sandboxId: sbx.id, port: sbx.port, status: sbx.status } };
  }

  const sandbox = ctx.sandboxId ? SandboxManager.getSandbox(ctx.sandboxId) : null;
  if (!sandbox) {
    return { success: false, error: "Sandbox is not active or not found." };
  }

  if (input.action === "run_command") {
    if (!input.command) return { success: false, error: "Command string is required." };
    const res = await sandbox.executeCommand(input.command, { timeoutMs: input.timeoutMs || 60000 });
    return {
      success: res.exitCode === 0,
      data: { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: res.durationMs },
      error: res.exitCode !== 0 ? res.stderr || res.stdout : undefined,
    };
  }

  if (input.action === "start_preview") {
    const previewRes = await sandbox.start();
    return {
      success: previewRes.success,
      data: { previewUrl: previewRes.previewUrl, port: sandbox.port },
      error: !previewRes.success ? previewRes.message : undefined,
    };
  }

  if (input.action === "capture_screenshot") {
    return { success: true, data: { status: "rendered", previewUrl: sandbox.previewUrl || `/api/runtime/sandbox/preview/${sandbox.id}` } };
  }

  if (input.action === "get_status") {
    const info = sandbox.getLiveMetrics();
    return { success: true, data: { status: sandbox.status, metrics: info } };
  }

  if (input.action === "stop") {
    sandbox.stop();
    await ctx.emitEvent("sandbox.stopped", "تم إيقاف بيئة Sandbox", {
      agentWorker: "sandbox",
      status: "completed",
    });
    return { success: true, data: { stopped: true } };
  }

  return { success: false, error: "Unsupported sandbox action." };
}
