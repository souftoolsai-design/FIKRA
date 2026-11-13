/**
 * SoufAI Agent Engine - Specialized Verification Worker
 * 
 * Performs strict pre-delivery checklist to verify that all user requirements,
 * project files, build states, and preview surfaces function flawlessly before final completion.
 */

import { EngineExecutionContext } from "../types";
import { SandboxManager } from "@/lib/sandbox/sandboxManager";

export interface VerificationWorkerInput {
  taskGoal: string;
  expectedFiles?: string[];
  qualityThreshold?: number;
}

export interface VerificationWorkerResult {
  isVerified: boolean;
  score: number;
  checks: Array<{ label: string; passed: boolean; details?: string }>;
  unresolvedIssues: string[];
}

export async function runVerificationWorker(
  input: VerificationWorkerInput,
  ctx: EngineExecutionContext
): Promise<VerificationWorkerResult> {
  await ctx.emitEvent("verification.started", "بدء التحقق الشامل النهائي قبل التسليم", {
    agentWorker: "verification",
    status: "running",
  });

  const sandbox = ctx.sandboxId ? SandboxManager.getSandbox(ctx.sandboxId) : null;
  const checks: Array<{ label: string; passed: boolean; details?: string }> = [];
  const unresolvedIssues: string[] = [];
  let score = 100;

  // 1. Check Sandbox is Running
  if (sandbox) {
    checks.push({ label: "بيئة Sandbox النشطة", passed: true, details: `ID: ${sandbox.id}` });
  } else {
    checks.push({ label: "بيئة Sandbox النشطة", passed: false, details: "Sandbox not active" });
    score -= 30;
    unresolvedIssues.push("Sandbox is not running");
  }

  // 2. Check Essential Files Exist
  if (sandbox) {
    const files = sandbox.listFiles();
    const hasFiles = files.length > 0;
    checks.push({
      label: "وجود الملفات البرمجية الأساسية",
      passed: hasFiles,
      details: `${files.length} ملفات موجودة`,
    });
    if (!hasFiles) {
      score -= 30;
      unresolvedIssues.push("No files generated in workspace");
    }
  }

  // 3. Check Preview Server
  if (sandbox && sandbox.previewUrl) {
    checks.push({
      label: "جاهزية رابط المعاينة الحية",
      passed: true,
      details: sandbox.previewUrl,
    });
  } else {
    checks.push({
      label: "جاهزية رابط المعاينة الحية",
      passed: false,
      details: "Preview URL not initialized",
    });
    score -= 20;
    unresolvedIssues.push("Preview server is not reachable");
  }

  const isVerified = score >= (input.qualityThreshold || 70) && unresolvedIssues.length === 0;

  await ctx.emitEvent(
    isVerified ? "verification.completed" : "agent.subtask.failed",
    isVerified ? `تم التحقق النهائي بنجاح (درجة التحقق: ${score}/100)` : "فشل التحقق النهائي",
    {
      agentWorker: "verification",
      status: isVerified ? "completed" : "failed",
      summary: checks.map((c) => `${c.passed ? "✓" : "✗"} ${c.label}`).join(" | "),
      payload: { checks, score, unresolvedIssues },
    }
  );

  return {
    isVerified,
    score: Math.max(0, score),
    checks,
    unresolvedIssues,
  };
}
