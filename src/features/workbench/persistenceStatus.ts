import type {
  SaveReport,
  StorageFailureReason,
  StorageLayerId,
} from "../../shared/repositories/projectRepository";
import { summarizeSave } from "../../shared/repositories/projectRepository";

export type PersistedState =
  | { kind: "saving" }
  | { kind: "saved" }
  | {
      kind: "degraded";
      failedLayer: StorageLayerId;
      reason: StorageFailureReason;
    }
  | {
      kind: "failed";
      reasons: Record<StorageLayerId, StorageFailureReason>;
    };

export interface PersistenceDescription {
  /** 顶栏短标签 */
  topbarLabel: string;
  /** 归档页状态说明 */
  archiveLabel: string;
  /** 提示条文案；无需提示时为空字符串 */
  notice: string;
  tone: "ok" | "busy" | "warn" | "error";
  canRetry: boolean;
}

const LAYER_NAMES: Record<StorageLayerId, string> = {
  indexedDb: "本地数据库",
  recoveryCopy: "恢复副本",
};

const REASON_DETAILS: Record<StorageFailureReason, string> = {
  quota: "空间不足",
  unsupported: "当前浏览器不支持",
  timeout: "长时间无响应",
  unknown: "写入被拒绝",
};

export function toPersistedState(report: SaveReport): PersistedState {
  const verdict = summarizeSave(report);
  if (verdict === "saved") return { kind: "saved" };
  const indexedDb = report.indexedDb;
  const recoveryCopy = report.recoveryCopy;
  if (verdict === "degraded") {
    if (!indexedDb.ok)
      return {
        kind: "degraded",
        failedLayer: "indexedDb",
        reason: indexedDb.failure.reason,
      };
    if (!recoveryCopy.ok)
      return {
        kind: "degraded",
        failedLayer: "recoveryCopy",
        reason: recoveryCopy.failure.reason,
      };
  }
  return {
    kind: "failed",
    reasons: {
      indexedDb: indexedDb.ok ? "unknown" : indexedDb.failure.reason,
      recoveryCopy: recoveryCopy.ok ? "unknown" : recoveryCopy.failure.reason,
    },
  };
}

export function describePersistedState(
  state: PersistedState,
): PersistenceDescription {
  switch (state.kind) {
    case "saving":
      return {
        topbarLabel: "保存中",
        archiveLabel: "正在保存更改…",
        notice: "",
        tone: "busy",
        canRetry: false,
      };
    case "saved":
      return {
        topbarLabel: "已保存",
        archiveLabel: "所有更改已保存",
        notice: "",
        tone: "ok",
        canRetry: false,
      };
    case "degraded": {
      const detail = REASON_DETAILS[state.reason];
      const canRetry = state.reason !== "unsupported";
      const archiveLabel =
        state.failedLayer === "indexedDb"
          ? `本地数据库${detail}，更改已保存到恢复副本`
          : `更改已保存到本地数据库，恢复副本因${detail}未更新，暂无兜底副本`;
      return {
        topbarLabel: "部分保存",
        archiveLabel,
        notice: canRetry
          ? `${archiveLabel}，可重试保存。`
          : `${archiveLabel}。`,
        tone: "warn",
        canRetry,
      };
    }
    case "failed": {
      const details = (
        Object.entries(state.reasons) as [
          StorageLayerId,
          StorageFailureReason,
        ][]
      )
        .map(
          ([layer, reason]) => `${LAYER_NAMES[layer]}${REASON_DETAILS[reason]}`,
        )
        .join("，");
      return {
        topbarLabel: "保存失败",
        archiveLabel: "保存失败，更改仅保留在当前页面",
        notice: `保存失败：${details}。更改仅保留在当前页面，请重试保存。`,
        tone: "error",
        canRetry: true,
      };
    }
  }
}
