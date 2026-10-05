import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import { IndexedDbService } from "../services/indexedDbService";

const FALLBACK_KEY = "latency-lab.workspace.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNode(value: unknown): RequestNode | undefined {
  if (!isRecord(value)) return undefined;
  const {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds,
    timeoutMs,
    retryCount,
    failureRate,
    fallbackNodeId,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !Array.isArray(dependencyIds)
  )
    return undefined;
  if (
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(jitterMs) ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(retryCount) ||
    !isFiniteNumber(failureRate)
  )
    return undefined;
  return {
    id,
    name,
    durationMs,
    jitterMs,
    dependencyIds: dependencyIds.filter(
      (id): id is string => typeof id === "string",
    ),
    timeoutMs,
    retryCount,
    failureRate,
    ...(typeof fallbackNodeId === "string" ? { fallbackNodeId } : {}),
  };
}

function parseScenario(value: unknown): ScenarioSnapshot | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.criticalPath)
  )
    return undefined;
  const { id, name, createdAt, concurrencyLimit, completionMs } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof createdAt !== "number" ||
    typeof completionMs !== "number"
  )
    return undefined;
  return {
    id,
    name,
    createdAt,
    completionMs,
    concurrencyLimit:
      typeof concurrencyLimit === "number" && concurrencyLimit > 0
        ? concurrencyLimit
        : null,
    nodes: value.nodes
      .map(parseNode)
      .filter((node): node is RequestNode => Boolean(node)),
    criticalPath: value.criticalPath.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function parseProject(
  value: unknown,
): { project: LatencyProject; recovered: boolean } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string"
  )
    return undefined;
  const sourceNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const parsedNodes = sourceNodes.map(parseNode);
  const nodes = parsedNodes.filter((node): node is RequestNode =>
    Boolean(node),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let recovered =
    !Array.isArray(value.nodes) || nodes.length !== sourceNodes.length;
  const safeNodes = nodes.map((node) => {
    const dependencyIds = node.dependencyIds.filter(
      (id) => id !== node.id && nodeIds.has(id),
    );
    const validFallback =
      node.fallbackNodeId &&
      node.fallbackNodeId !== node.id &&
      nodeIds.has(node.fallbackNodeId)
        ? node.fallbackNodeId
        : undefined;
    if (
      dependencyIds.length !== node.dependencyIds.length ||
      validFallback !== node.fallbackNodeId
    )
      recovered = true;
    return {
      ...node,
      dependencyIds,
      ...(validFallback
        ? { fallbackNodeId: validFallback }
        : { fallbackNodeId: undefined }),
    };
  });
  const scenarioSource = Array.isArray(value.scenarios) ? value.scenarios : [];
  const scenarios = scenarioSource
    .map(parseScenario)
    .filter((scenario): scenario is ScenarioSnapshot => Boolean(scenario));
  if (
    !Array.isArray(value.scenarios) ||
    scenarios.length !== scenarioSource.length
  )
    recovered = true;
  const now = Date.now();
  const project: LatencyProject = {
    id: value.id,
    title: value.title,
    nodes: safeNodes,
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit > 0
        ? Math.floor(value.concurrencyLimit)
        : null,
    scenarios,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
  };
  return { project, recovered };
}

function parseWorkspace(
  value: unknown,
): { document: WorkspaceDocument; recovered: boolean } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects))
    return undefined;
  const parsed = value.projects.map(parseProject);
  const projects = parsed
    .filter((entry): entry is { project: LatencyProject; recovered: boolean } =>
      Boolean(entry),
    )
    .map((entry) => entry.project);
  if (!projects.length) return undefined;
  const firstProject = projects[0];
  if (!firstProject) return undefined;
  const activeProjectId = projects.some(
    (project) => project.id === value.activeProjectId,
  )
    ? String(value.activeProjectId)
    : firstProject.id;
  const recovered =
    projects.length !== parsed.length ||
    parsed.some((entry) => entry?.recovered);
  return { document: { version: 1, activeProjectId, projects }, recovered };
}

export interface WorkspaceStorage {
  read(): Promise<unknown>;
  write(value: WorkspaceDocument): Promise<void>;
}

export type StorageLayerId = "indexedDb" | "recoveryCopy";

export type StorageFailureReason =
  "quota" | "unsupported" | "timeout" | "unknown";

export interface StorageLayerFailure {
  reason: StorageFailureReason;
  message: string;
}

export type StorageLayerResult =
  { ok: true } | { ok: false; failure: StorageLayerFailure };

export interface SaveReport {
  indexedDb: StorageLayerResult;
  recoveryCopy: StorageLayerResult;
}

export type SaveVerdict = "saved" | "degraded" | "failed";

export function summarizeSave(report: SaveReport): SaveVerdict {
  if (report.indexedDb.ok && report.recoveryCopy.ok) return "saved";
  if (!report.indexedDb.ok && !report.recoveryCopy.ok) return "failed";
  return "degraded";
}

const STORAGE_TIMEOUT_MS = 4000;

class StorageTimeoutError extends Error {
  constructor(layer: string) {
    super(`${layer}长时间无响应`);
    this.name = "StorageTimeoutError";
  }
}

function classifyStorageError(error: unknown): StorageFailureReason {
  if (error instanceof StorageTimeoutError) return "timeout";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError" || /quota|空间不足/i.test(message))
    return "quota";
  if (/不支持|not supported/i.test(message)) return "unsupported";
  if (/超时|无响应|timed?\s*out/i.test(message)) return "timeout";
  return "unknown";
}

function toFailure(error: unknown): StorageLayerFailure {
  return {
    reason: classifyStorageError(error),
    message: error instanceof Error ? error.message : String(error),
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  layer: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StorageTimeoutError(layer)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function attempt(
  operation: () => Promise<void>,
): Promise<StorageLayerResult> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: toFailure(error) };
  }
}

export class ProjectRepository {
  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
    private readonly timeoutMs: number = STORAGE_TIMEOUT_MS,
  ) {}

  private readRecoveryCopy() {
    const local = localStorage.getItem(FALLBACK_KEY);
    if (!local) return undefined;
    try {
      const fallback = parseWorkspace(JSON.parse(local) as unknown);
      if (fallback) return { ...fallback, recovered: true };
    } catch {
      localStorage.removeItem(FALLBACK_KEY);
    }
    return undefined;
  }

  async load(): Promise<{ document: WorkspaceDocument; recovered: boolean }> {
    try {
      const stored = parseWorkspace(
        await withTimeout(this.storage.read(), this.timeoutMs, "本地数据库"),
      );
      if (stored) return stored;
    } catch {
      // 数据库读取失败或无响应时，回落到恢复副本。
    }
    const fallback = this.readRecoveryCopy();
    if (fallback) return fallback;
    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
    };
  }

  async save(document: WorkspaceDocument): Promise<SaveReport> {
    const [indexedDb, recoveryCopy] = await Promise.all([
      attempt(() =>
        withTimeout(this.storage.write(document), this.timeoutMs, "本地数据库"),
      ),
      attempt(async () => {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(document));
      }),
    ]);
    return { indexedDb, recoveryCopy };
  }
}
