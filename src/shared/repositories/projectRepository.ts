import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../domain/types";
import {
  classifyStorageError,
  layerStatus,
  LAYER_NAMES,
  StorageTimeoutError,
  type FailureReason,
  type LayerStatus,
  type SaveOutcome,
  type StorageLayerId,
} from "./persistenceStatus";
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
  /** 探测主数据库在当前环境是否可用（如 IndexedDB 支持检测） */
  isSupported?(): boolean;
}

export interface LoadResult {
  document: WorkspaceDocument;
  /** 数据恢复自损坏/降级存储时为 true */
  recovered: boolean;
  /** 启动时数据来源：主库 / 恢复副本 / 内置示例 */
  source: "primary" | "fallback" | "example";
  outcome: SaveOutcome;
}

const DEFAULT_LAYER_TIMEOUT_MS = 10_000;

/** 单层读取结果：要么拿到值（可能为空），要么带原因失败 */
type ReadAttempt =
  | { ok: true; value: unknown }
  | { ok: false; reason: FailureReason };

export class ProjectRepository {
  private readonly layerTimeoutMs: number;

  constructor(
    private readonly storage: WorkspaceStorage = new IndexedDbService(),
    options: { layerTimeoutMs?: number } = {},
  ) {
    this.layerTimeoutMs = options.layerTimeoutMs ?? DEFAULT_LAYER_TIMEOUT_MS;
  }

  async load(): Promise<LoadResult> {
    const started = Date.now();
    const [primaryAttempt, fallbackAttempt] = await Promise.all([
      this.attemptPrimaryRead(),
      this.attemptFallbackRead(),
    ]);

    if (primaryAttempt.ok) {
      const parsed = parseWorkspace(primaryAttempt.value);
      if (parsed) {
        return {
          document: parsed.document,
          recovered: parsed.recovered,
          source: "primary",
          outcome: {
            primary: layerStatus("primary", "ok"),
            fallback: this.fallbackReadStatus(fallbackAttempt),
            durationMs: Date.now() - started,
          },
        };
      }
    }

    if (fallbackAttempt.ok) {
      const parsed = parseWorkspace(fallbackAttempt.value);
      if (parsed) {
        return {
          document: parsed.document,
          recovered: true,
          source: "fallback",
          outcome: {
            primary: this.primaryDegradedReadStatus(
              primaryAttempt,
              /* damaged */ primaryAttempt.ok,
            ),
            fallback: layerStatus("fallback", "ok", "已从恢复副本恢复数据"),
            durationMs: Date.now() - started,
          },
        };
      }
      // 恢复副本内容损坏，清掉以免反复命中
      try {
        localStorage.removeItem(FALLBACK_KEY);
      } catch {
        // 忽略清理失败
      }
    }

    return {
      document: {
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      },
      recovered: true,
      source: "example",
      outcome: {
        primary: this.primaryDegradedReadStatus(
          primaryAttempt,
          primaryAttempt.ok,
        ),
        fallback: this.fallbackReadStatus(fallbackAttempt),
        durationMs: Date.now() - started,
      },
    };
  }

  /**
   * 保存到两层存储并返回各自结果。
   *
   * “保存成功”不再以是否抛异常表达：只要任一层确认写入，调用方就应
   * 给出与实际可用数据一致的状态。两层都失败时 outcome.health === "none"。
   */
  async save(document: WorkspaceDocument): Promise<SaveOutcome> {
    const started = Date.now();

    // 恢复副本走 JSON 序列化，先单独尝试，序列化失败是确定性错误
    let serialized: string | undefined;
    let serializationError: unknown;
    try {
      serialized = JSON.stringify(document);
    } catch (error) {
      serializationError = error;
    }

    const primaryTask = this.runLayer(() => this.storage.write(document), {
      layer: "primary",
      unsupported: () => this.primaryExplicitlyUnsupported(),
    });
    const fallbackTask =
      serialized === undefined
        ? Promise.resolve(
            layerStatus(
              "fallback",
              classifyStorageError(serializationError),
              "数据无法序列化，副本未能写入",
            ),
          )
        : this.runLayer(
            async () => {
              localStorage.setItem(FALLBACK_KEY, serialized);
            },
            {
              layer: "fallback",
              unsupported: () => !this.localStorageAvailable(),
            },
          );

    const [primary, fallback] = await Promise.all([primaryTask, fallbackTask]);
    return { primary, fallback, durationMs: Date.now() - started };
  }

  private async attemptPrimaryRead(): Promise<ReadAttempt> {
    // 有明确的能力探测且判定不支持（如浏览器无 IndexedDB）
    if (this.primaryExplicitlyUnsupported())
      return { ok: false, reason: "unsupported" };
    try {
      const value = await this.withLayerTimeout(
        "primary",
        this.storage.read(),
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: classifyStorageError(error) };
    }
  }

  private async attemptFallbackRead(): Promise<ReadAttempt> {
    if (!this.localStorageAvailable())
      return { ok: false, reason: "unsupported" };
    let raw: string | null;
    try {
      raw = localStorage.getItem(FALLBACK_KEY);
    } catch (error) {
      return { ok: false, reason: classifyStorageError(error) };
    }
    if (raw === null) return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  private primaryExplicitlyUnsupported(): boolean {
    return (
      typeof this.storage.isSupported === "function" &&
      !this.storage.isSupported()
    );
  }

  private localStorageAvailable(): boolean {
    try {
      const probeKey = `${FALLBACK_KEY}.probe`;
      localStorage.setItem(probeKey, "1");
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  private fallbackReadStatus(attempt: ReadAttempt): LayerStatus {
    if (attempt.ok) {
      return layerStatus(
        "fallback",
        "ok",
        attempt.value === undefined
          ? "恢复副本尚为空"
          : "恢复副本可读取",
      );
    }
    if (attempt.reason === "unsupported")
      return layerStatus("fallback", "unsupported", "本地存储被禁用");
    if (attempt.reason === "timeout")
      return layerStatus("fallback", "timeout");
    if (attempt.reason === "quota") return layerStatus("fallback", "quota");
    return layerStatus("fallback", "error", "恢复副本无法读取");
  }

  private primaryDegradedReadStatus(
    attempt: ReadAttempt,
    damaged: boolean,
  ): LayerStatus {
    if (damaged)
      return layerStatus(
        "primary",
        "error",
        "主库数据无法识别，未被采用",
      );
    if (attempt.ok) return layerStatus("primary", "ok");
    if (attempt.reason === "unsupported")
      return layerStatus("primary", "unsupported");
    if (attempt.reason === "timeout")
      return layerStatus("primary", "timeout", "读取长时间无响应");
    if (attempt.reason === "quota") return layerStatus("primary", "quota");
    return layerStatus("primary", "error", "读取失败");
  }

  /**
   * 执行单层写入：归类失败原因；超过层超时仍未确认时给出 timeout 状态，
   * 避免界面无限停留在“保存中”。
   */
  private async runLayer(
    task: () => Promise<void>,
    options: {
      layer: StorageLayerId;
      unsupported: () => boolean;
    },
  ): Promise<LayerStatus> {
    if (options.unsupported())
      return layerStatus(options.layer, "unsupported");
    try {
      await this.withLayerTimeout(options.layer, task());
      return layerStatus(options.layer, "ok");
    } catch (error) {
      return layerStatus(options.layer, classifyStorageError(error));
    }
  }

  private withLayerTimeout<T>(layer: StorageLayerId, pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StorageTimeoutError(LAYER_NAMES[layer]));
      }, this.layerTimeoutMs);
    });
    // 防止超时后原 Promise 拒绝造成未处理异常
    pending.catch(() => {});
    return Promise.race([pending, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
