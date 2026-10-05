/**
 * 两层持久化（IndexedDB 主数据库 + localStorage 恢复副本）的统一状态模型。
 *
 * “保存成功”的定义：至少有一层确认写入了最新版本，数据即可安全保留；
 * 界面状态必须由两层各自的结果推导，而不是用一个布尔值概括。
 */

export type StorageLayerId = "primary" | "fallback";

/** 失败原因：空间不足 / 浏览器不支持 / 长时间无响应 / 其他错误 */
export type FailureReason = "quota" | "unsupported" | "timeout" | "error";

export type LayerState = "ok" | FailureReason;

export interface LayerStatus {
  layer: StorageLayerId;
  state: LayerState;
  /** 面向用户的单层状态描述，例如“空间不足，未能写入” */
  detail: string;
}

export interface SaveOutcome {
  primary: LayerStatus;
  fallback: LayerStatus;
  durationMs: number;
}

/**
 * dual          两层都写入，数据双份保存
 * fallback-only 主库失败，恢复副本持有最新数据（数据安全，但缺主库）
 * primary-only  主库成功，恢复副本失败（数据安全，但没有兜底副本）
 * none          两层都失败，最新数据只存在于当前页面内存
 */
export type SaveHealth = "dual" | "fallback-only" | "primary-only" | "none";

export type StorageTone = "ok" | "warn" | "danger";

export type StoragePhase = "idle" | "saving" | "settled";

/** 启动时数据来源 */
export type WorkspaceSource = "primary" | "fallback" | "example";

export interface StorageLayerView {
  id: StorageLayerId;
  name: string;
  state: LayerState | "pending";
  detail: string;
}

export interface StoragePresentation {
  phase: StoragePhase;
  health: SaveHealth;
  tone: StorageTone;
  /** 顶栏与归档页共用的短标签 */
  label: string;
  /** 一句话概括，用于提示语与悬浮说明 */
  summary: string;
  /** 与实际可用数据一致的完整说明 */
  detail: string;
  /** 是否存在重试可能修复的失败层（不支持类失败重试无意义） */
  retryable: boolean;
  layers: StorageLayerView[];
}

/** 等待单层写入超过该时长即判定为“长时间无响应” */
export class StorageTimeoutError extends Error {
  override readonly name = "StorageTimeoutError";
  constructor(layerName: string) {
    super(`${layerName}长时间无响应`);
  }
}

/**
 * 把底层抛出的异常归类为四种失败原因。
 */
export function classifyStorageError(error: unknown): FailureReason {
  if (error instanceof StorageTimeoutError) return "timeout";
  if (error instanceof DOMException) {
    const name = error.name;
    if (name === "QuotaExceededError") return "quota";
    // 隐私模式 / 沙箱环境下常见的拒绝方式
    if (name === "SecurityError" || name === "NotSupportedError")
      return "unsupported";
    // Safari 历史版本用数字码表达配额错误
    if (error.code === 22 || error.code === 1014) return "quota";
  }
  const maybeNamed = error as { name?: unknown; message?: unknown } | null;
  const name = typeof maybeNamed?.name === "string" ? maybeNamed.name : "";
  const message =
    typeof maybeNamed?.message === "string" ? maybeNamed.message : "";
  if (/quota|space|exceed/i.test(`${name} ${message}`)) return "quota";
  if (/不支持|unavailable|not\s*support/i.test(`${name} ${message}`))
    return "unsupported";
  return "error";
}

export const LAYER_NAMES: Record<StorageLayerId, string> = {
  primary: "IndexedDB 主数据库",
  fallback: "本地恢复副本",
};

const LAYER_DETAILS: Record<StorageLayerId, Record<LayerState, string>> = {
  primary: {
    ok: "已写入最新内容",
    quota: "空间不足，未能写入",
    unsupported: "浏览器不支持 IndexedDB",
    timeout: "长时间无响应，已停止等待",
    error: "写入失败",
  },
  fallback: {
    ok: "恢复副本已更新",
    quota: "存储空间不足，副本写入失败",
    unsupported: "本地存储被禁用，无法写副本",
    timeout: "长时间无响应，副本未更新",
    error: "恢复副本写入失败",
  },
};

export function layerStatus(
  layer: StorageLayerId,
  state: LayerState,
  detail?: string,
): LayerStatus {
  return { layer, state, detail: detail ?? LAYER_DETAILS[layer][state] };
}

export function healthOf(outcome: SaveOutcome): SaveHealth {
  const primaryOk = outcome.primary.state === "ok";
  const fallbackOk = outcome.fallback.state === "ok";
  if (primaryOk && fallbackOk) return "dual";
  if (!primaryOk && fallbackOk) return "fallback-only";
  if (primaryOk && !fallbackOk) return "primary-only";
  return "none";
}

const RETRYABLE_STATES: readonly FailureReason[] = ["quota", "timeout", "error"];

function isRetryable(status: LayerStatus): boolean {
  return (
    status.state !== "ok" &&
    RETRYABLE_STATES.includes(status.state as FailureReason)
  );
}

const HEALTH_LABELS: Record<SaveHealth, string> = {
  dual: "已保存",
  "fallback-only": "仅恢复副本已保存",
  "primary-only": "已保存 · 无恢复副本",
  none: "保存失败",
};

const HEALTH_SUMMARIES: Record<SaveHealth, string> = {
  dual: "主数据库与恢复副本均已保存",
  "fallback-only": "更改已存入恢复副本，主数据库不可用",
  "primary-only": "主数据库已保存，恢复副本不可用",
  none: "两层存储均未保存，更改仅保留在本页面",
};

const DUAL_DETAIL =
  "IndexedDB 主数据库与本地恢复副本均已写入最新更改，刷新或重新打开后会自动恢复。";

function degradedDetail(
  health: Exclude<SaveHealth, "dual">,
  outcome: SaveOutcome,
): string {
  if (health === "fallback-only") {
    switch (outcome.primary.state) {
      case "quota":
        return "浏览器数据库剩余空间不足，主库未能写入；本次更改已确认存入本地恢复副本，关闭页面不会丢失。清理存储空间后重试，可恢复双份保存。";
      case "unsupported":
        return "当前浏览器不支持 IndexedDB，主库不可用；本次更改已确认存入本地恢复副本，关闭页面不会丢失。";
      case "timeout":
        return "浏览器数据库长时间无响应，主库未能写入；本次更改已确认存入本地恢复副本，关闭页面不会丢失。数据库恢复后重试即可恢复双份保存。";
      default:
        return "浏览器数据库写入失败，本次更改已确认存入本地恢复副本，关闭页面不会丢失；可重试恢复双份保存。";
    }
  }
  if (health === "primary-only") {
    switch (outcome.fallback.state) {
      case "quota":
        return "本地恢复副本因存储空间不足未能写入。主库中的更改完好，但本次没有兜底副本；建议清理存储空间后重试，补写恢复副本。";
      case "unsupported":
        return "当前环境禁用了本地存储，无法写入恢复副本。主库中的更改完好，但本次没有兜底。";
      case "timeout":
        return "恢复副本写入时长时间无响应。主库中的更改完好，但本次暂无兜底副本，可重试补写。";
      default:
        return "恢复副本写入失败。主库中的更改完好，但本次暂无兜底副本，可重试补写。";
    }
  }
  return `两层存储都未能保存本次更改：${LAYER_NAMES.primary}——${outcome.primary.detail}；${LAYER_NAMES.fallback}——${outcome.fallback.detail}。更改目前只保留在本页面中，请勿关闭或刷新，处理后重试。`;
}

const TONE_BY_HEALTH: Record<SaveHealth, StorageTone> = {
  dual: "ok",
  "fallback-only": "warn",
  "primary-only": "warn",
  none: "danger",
};

function toLayerView(
  status: LayerStatus,
  pending: boolean,
): StorageLayerView {
  return {
    id: status.layer,
    name: LAYER_NAMES[status.layer],
    state: pending ? "pending" : status.state,
    detail: pending ? "正在写入…" : status.detail,
  };
}

/**
 * 由保存阶段与两层结果推导唯一的展示状态，顶栏与归档页共用，保证说法一致。
 */
export function buildStoragePresentation(input: {
  phase: StoragePhase;
  outcome: SaveOutcome | null;
  source?: WorkspaceSource;
}): StoragePresentation {
  const { phase, outcome, source = "primary" } = input;
  const fallbackOutcome: SaveOutcome = outcome ?? {
    primary: layerStatus("primary", "error"),
    fallback: layerStatus("fallback", "error"),
    durationMs: 0,
  };
  const health = healthOf(fallbackOutcome);
  const tone = TONE_BY_HEALTH[health];
  const retryable =
    phase !== "saving" &&
    (isRetryable(fallbackOutcome.primary) ||
      isRetryable(fallbackOutcome.fallback));

  if (phase === "saving") {
    return {
      phase,
      health,
      tone,
      label: "保存中…",
      summary: "正在写入两层存储…",
      detail: "正在把更改写入 IndexedDB 主数据库与本地恢复副本…",
      retryable: false,
      layers: [
        toLayerView(fallbackOutcome.primary, true),
        toLayerView(fallbackOutcome.fallback, true),
      ],
    };
  }

  // 首次载入内置示例、尚未产生过用户保存时
  if (phase === "idle" && source === "example") {
    const degraded = health !== "dual";
    return {
      phase,
      health,
      tone: degraded ? tone : "ok",
      label: degraded ? HEALTH_LABELS[health] : "示例已载入",
      summary: degraded
        ? HEALTH_SUMMARIES[health]
        : "已载入内置示例工作区",
      detail: degraded
        ? degradedDetail(health, fallbackOutcome)
        : "已载入内置示例工作区，之后的修改会自动保存到这台设备的浏览器中。",
      retryable,
      layers: [
        toLayerView(fallbackOutcome.primary, false),
        toLayerView(fallbackOutcome.fallback, false),
      ],
    };
  }

  return {
    phase,
    health,
    tone,
    label: HEALTH_LABELS[health],
    summary: HEALTH_SUMMARIES[health],
    detail:
      health === "dual"
        ? DUAL_DETAIL
        : degradedDetail(health, fallbackOutcome),
    retryable,
    layers: [
      toLayerView(fallbackOutcome.primary, false),
      toLayerView(fallbackOutcome.fallback, false),
    ],
  };
}
