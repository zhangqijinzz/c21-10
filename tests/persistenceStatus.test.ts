import { describe, expect, it } from "vitest";
import {
  describePersistedState,
  toPersistedState,
} from "../src/features/workbench/persistenceStatus";
import type { SaveReport } from "../src/shared/repositories/projectRepository";

function report(
  indexedDb: SaveReport["indexedDb"],
  recoveryCopy: SaveReport["recoveryCopy"],
): SaveReport {
  return { indexedDb, recoveryCopy };
}

const ok = { ok: true } as const;
function fail(reason: "quota" | "unsupported" | "timeout" | "unknown") {
  return { ok: false as const, failure: { reason, message: reason } };
}

describe("persisted state mapping", () => {
  it("treats a save as saved only when both layers succeed", () => {
    expect(toPersistedState(report(ok, ok))).toEqual({ kind: "saved" });
    expect(describePersistedState({ kind: "saved" }).topbarLabel).toBe(
      "已保存",
    );
  });

  it("treats a database failure with a written recovery copy as degraded, not failed", () => {
    const state = toPersistedState(report(fail("quota"), ok));
    expect(state).toEqual({
      kind: "degraded",
      failedLayer: "indexedDb",
      reason: "quota",
    });
    const description = describePersistedState(state);
    expect(description.tone).toBe("warn");
    expect(description.topbarLabel).toBe("部分保存");
    expect(description.archiveLabel).toContain("恢复副本");
    expect(description.canRetry).toBe(true);
  });

  it("flags a missing recovery copy even when the database write succeeded", () => {
    const state = toPersistedState(report(ok, fail("quota")));
    expect(state).toEqual({
      kind: "degraded",
      failedLayer: "recoveryCopy",
      reason: "quota",
    });
    const description = describePersistedState(state);
    expect(description.archiveLabel).toContain("本地数据库");
    expect(description.archiveLabel).toContain("兜底");
    expect(description.canRetry).toBe(true);
  });

  it("disables retry when the browser does not support the database", () => {
    const state = toPersistedState(report(fail("unsupported"), ok));
    const description = describePersistedState(state);
    expect(description.archiveLabel).toContain("不支持");
    expect(description.canRetry).toBe(false);
  });

  it("distinguishes an unresponsive layer from a quota failure", () => {
    const timeout = describePersistedState(
      toPersistedState(report(fail("timeout"), ok)),
    );
    const quota = describePersistedState(
      toPersistedState(report(fail("quota"), ok)),
    );
    expect(timeout.archiveLabel).toContain("无响应");
    expect(quota.archiveLabel).toContain("空间不足");
    expect(timeout.archiveLabel).not.toBe(quota.archiveLabel);
  });

  it("reports failure only when both layers failed", () => {
    const state = toPersistedState(report(fail("quota"), fail("unknown")));
    expect(state.kind).toBe("failed");
    const description = describePersistedState(state);
    expect(description.tone).toBe("error");
    expect(description.topbarLabel).toBe("保存失败");
    expect(description.canRetry).toBe(true);
  });
});
