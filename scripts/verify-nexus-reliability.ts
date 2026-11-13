import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  AgentRepository,
  closeDb,
  ensureMigrationsRun,
  getReadyDb,
} from "../lib/db";
import * as schema from "../lib/db/schema";
import { createClient } from "@libsql/client";
import { MIGRATION_STATEMENTS } from "../lib/db/migrate";
import { NexusModelRouter } from "../lib/agent/nexus/modelRouter";
import type { NexusModelRoutingCriteria } from "../lib/agent/nexus/types";
import { getInMemoryAdminConfig } from "../lib/adminConfigStore";
import { decideNexusTaskCompletion } from "../lib/agent/nexus/taskLifecycle";

async function verifyLeases(): Promise<void> {
  const taskId = `nexus_verify_${Date.now()}`;
  await AgentRepository.createTask({
    id: taskId,
    userId: "nexus-reliability-test",
    goal: "Verify lease fencing",
    status: "pending",
  });

  const claims = await Promise.all([
    AgentRepository.claimTask(taskId, "worker-a", "token-a", 30_000),
    AgentRepository.claimTask(taskId, "worker-b", "token-b", 30_000),
  ]);
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1, "only one concurrent worker may claim a task");
  const firstClaim = winners[0]!;
  const firstLease = {
    workerId: firstClaim.leaseOwner!,
    token: firstClaim.leaseToken!,
    generation: firstClaim.leaseGeneration,
  };
  assert.equal(await AgentRepository.ownsTaskLease(taskId, firstLease), true);
  assert.equal(await AgentRepository.renewTaskLease(firstLease, taskId, 30_000), true);
  assert.equal(await AgentRepository.updateTaskOwned(taskId, firstLease, ["running"], {
    status: "executing",
  }), true);

  const subtaskId = `${taskId}_step`;
  await AgentRepository.createSubtask({
    id: subtaskId,
    taskId,
    title: "Test fencing",
    agentWorker: "verification",
  }, firstLease);
  await AgentRepository.updateSubtaskOwned(taskId, subtaskId, firstLease, {
    status: "running",
  });
  await AgentRepository.saveCheckpoint(taskId, 1, "before takeover", { safe: true }, firstLease);

  const database = await getReadyDb();
  await database
    .update(schema.agentTasks)
    .set({ leaseExpiresAt: new Date(Date.now() - 1) })
    .where(eq(schema.agentTasks.id, taskId));

  const secondClaim = await AgentRepository.claimTask(taskId, "worker-b", "token-b", 30_000);
  assert.ok(secondClaim, "a worker may take over an expired lease");
  const secondLease = {
    workerId: secondClaim.leaseOwner!,
    token: secondClaim.leaseToken!,
    generation: secondClaim.leaseGeneration,
  };
  assert.ok(secondLease.generation > firstLease.generation, "takeover must increment lease generation");
  assert.equal(await AgentRepository.ownsTaskLease(taskId, firstLease), false);
  assert.equal(await AgentRepository.ownsTaskLease(taskId, secondLease), true);

  assert.equal(
    await AgentRepository.updateTaskOwned(taskId, firstLease, ["executing"], { currentStep: 2 }),
    false,
    "stale task updates must not be acknowledged"
  );
  await assert.rejects(
    AgentRepository.updateSubtaskOwned(taskId, subtaskId, firstLease, { status: "completed" }),
    "stale subtask updates must be rejected"
  );
  await assert.rejects(
    AgentRepository.saveCheckpoint(taskId, 2, "stale checkpoint", {}, firstLease),
    "stale checkpoint writes must be rolled back"
  );
  await assert.rejects(
    AgentRepository.logEvent({
      taskId,
      lease: firstLease,
      eventType: "test.stale",
      title: "stale",
    }),
    "stale event writes must be rejected"
  );
  await assert.rejects(
    AgentRepository.logToolCall({
      taskId,
      lease: firstLease,
      toolName: "test",
      agentWorker: "verification",
    }),
    "stale tool-call writes must be rejected"
  );
  await assert.equal(await AgentRepository.getLatestCheckpoint(taskId).then((checkpoint) =>
    checkpoint?.stepNumber
  ), 1, "a rejected checkpoint transaction must not leave a partial row");

  assert.equal(await AgentRepository.logEvent({
    taskId,
    lease: secondLease,
    eventType: "test.current",
    title: "current",
  }).then((event) => event.eventType), "test.current");
  await AgentRepository.logToolCall({
    taskId,
    lease: secondLease,
    toolName: "test",
    agentWorker: "verification",
    args: { keys: ["safe"] },
  });
  await AgentRepository.recordRun({
    taskId,
    userId: "nexus-reliability-test",
    lease: secondLease,
    modelUsed: "test-only",
    totalDurationMs: 1,
  });

  assert.equal(await AgentRepository.releaseTaskLease(taskId, secondLease, "paused"), true);
  assert.equal(await AgentRepository.ownsTaskLease(taskId, secondLease), false);
  assert.equal(
    await AgentRepository.updateTaskOwned(taskId, secondLease, ["paused"], { currentStep: 3 }),
    false,
    "released leases must no longer authorize writes"
  );

  const task = await AgentRepository.getTask(taskId);
  assert.equal(task?.status, "paused");
  assert.equal(task?.leaseToken, null);

  const cancelledTaskId = `${taskId}_cancel`;
  await AgentRepository.createTask({
    id: cancelledTaskId,
    userId: "nexus-reliability-test",
    goal: "Verify cancellation fencing",
    status: "pending",
  });
  const cancellationClaim = await AgentRepository.claimTask(
    cancelledTaskId,
    "worker-cancel",
    "cancel-token",
    30_000
  );
  assert.ok(cancellationClaim);
  const cancellationLease = {
    workerId: cancellationClaim.leaseOwner!,
    token: cancellationClaim.leaseToken!,
    generation: cancellationClaim.leaseGeneration,
  };
  assert.equal(await AgentRepository.cancelTask(cancelledTaskId, "nexus-reliability-test"), true);
  assert.equal(await AgentRepository.ownsTaskLease(cancelledTaskId, cancellationLease), false);
  assert.equal(await AgentRepository.updateTaskOwned(
    cancelledTaskId,
    cancellationLease,
    ["running"],
    { currentStep: 1 }
  ), false, "cancellation must fence out the previous worker");
}

async function verifyRouting(): Promise<void> {
  const criteria: NexusModelRoutingCriteria = {
    taskComplexity: "medium",
    requiresReasoning: false,
    requiresCoding: false,
    requiresVision: false,
    requiresStructuredOutput: false,
    minContextTokens: 1_000,
    latencyPreference: "balanced",
    costSensitivity: "standard",
    preferredTiers: ["core"],
    fallbackTiers: [],
  };
  const model = "gemini-3.7-flash";
  const testConfig = () => ({
    ...getInMemoryAdminConfig(),
    activeModelTiers: ["core"],
    modelProviders: {
      core: [{
        providerId: "gemini",
        models: [model],
        activeModels: [model],
        keys: ["test-key-not-a-credential"],
        priority: 1,
      }],
    },
  });
  const router = new NexusModelRouter({
    loadConfig: async () => testConfig(),
    executePrompt: async (options) => {
      assert.equal(options.strictModelSelection, true);
      assert.equal(options.firestoreAssignments?.core?.[0]?.model, model);
      return {
        text: "deterministic test result",
        providerUsed: "gemini",
        modelUsed: model,
        keyUsedMasked: "test",
        attemptsCount: 1,
        fallbackOccurred: false,
      };
    },
    wait: async () => undefined,
    random: () => 0,
  });

  const result = await router.executeWithRouting(criteria, {
    prompt: "deterministic test only",
    explicitModelId: "core",
  });
  assert.equal(result.result.modelUsed, model);
  assert.equal(result.decision.selectedProvider, "gemini");

  const mismatchedRouter = new NexusModelRouter({
    loadConfig: async () => testConfig(),
    executePrompt: async () => ({
      text: "unexpected result",
      providerUsed: "other-provider",
      modelUsed: "other-model",
      keyUsedMasked: "test",
      attemptsCount: 1,
      fallbackOccurred: true,
    }),
    wait: async () => undefined,
    random: () => 0,
  });
  await assert.rejects(
    mismatchedRouter.executeWithRouting(criteria, {
      prompt: "deterministic mismatch test",
    }),
    "router must reject an executor result from an unassigned model/provider"
  );
}

function verifyCompletionPolicy(): void {
  const base = {
    nodes: [],
    delegations: [],
    finalResponse: "",
    checkpointPersisted: true,
    persistenceFailed: false,
    leaseOwned: false,
    timedOut: false,
  };
  assert.equal(
    decideNexusTaskCompletion({ ...base, cancelled: false }).status,
    "recovery_required",
    "lease loss must not be reported as user cancellation"
  );
  assert.equal(
    decideNexusTaskCompletion({ ...base, cancelled: true }).status,
    "cancelled",
    "explicit cancellation must remain a cancelled terminal state"
  );
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "souftools-nexus-verify-"));
  const dbPath = path.join(tempDir, "nexus.db");
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;
  const previousAuthToken = process.env.TURSO_DATABASE_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.TURSO_DATABASE_AUTH_TOKEN;

  try {
    const agentTasksSchema = MIGRATION_STATEMENTS.find((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS "agent_tasks"')
    );
    assert.ok(agentTasksSchema, "agent task schema statement must exist");
    const legacySchema = agentTasksSchema!
      .replace(/^\s*lease_token TEXT,\r?\n/m, "")
      .replace(/^\s*lease_generation INTEGER NOT NULL DEFAULT 0,\r?\n/m, "");
    assert.notEqual(legacySchema, agentTasksSchema, "legacy schema must omit v4 lease columns");
    const legacyClient = createClient({ url: `file:${dbPath}` });
    await legacyClient.execute(legacySchema);
    legacyClient.close();

    await ensureMigrationsRun();
    const database = await getReadyDb();
    const columns = await database.all<{ name: string }>(
      `PRAGMA table_info('agent_tasks')`
    );
    const names = new Set(columns.map((column) => column.name));
    assert.ok(names.has("lease_token"), "lease token migration must be applied on a fresh DB");
    assert.ok(names.has("lease_generation"), "lease generation migration must be applied on a fresh DB");
    await verifyLeases();
    await verifyRouting();
    verifyCompletionPolicy();
    console.log("Nexus reliability verification passed (isolated libSQL; no provider calls).");
  } finally {
    await closeDb();
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previousToken;
    if (previousAuthToken === undefined) delete process.env.TURSO_DATABASE_AUTH_TOKEN;
    else process.env.TURSO_DATABASE_AUTH_TOKEN = previousAuthToken;

    let cleanupError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    if (cleanupError) {
      console.warn(`Temporary libSQL files will remain until the process exits: ${tempDir}`);
    }
  }
}

void main().catch((error) => {
  console.error("Nexus reliability verification failed:", error);
  process.exitCode = 1;
});
