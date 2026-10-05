import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import {
  buildStoragePresentation,
  classifyStorageError,
  healthOf,
  StorageTimeoutError,
} from "../src/shared/repositories/persistenceStatus";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

type FailureMode = null | "quota" | "unsupported" | "timeout" | "error";

class MemoryStorage {
  value: unknown = undefined;
  writeFailure: FailureMode = null;
  supported = true;
  private delayMs = 0;

  async read(): Promise<unknown> {
    await this.tick();
    if (this.writeFailure === "unsupported" && !this.supported)
      throw new Error("浏览器不支持 IndexedDB");
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    await this.tick();
    if (this.writeFailure === "quota")
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    if (this.writeFailure === "unsupported")
      throw new Error("浏览器不支持 IndexedDB");
    if (this.writeFailure === "timeout")
      await new Promise<void>(() => {});
    if (this.writeFailure === "error") throw new Error("simulated write failure");
    this.value = structuredClone(value);
  }
  isSupported(): boolean {
    return this.supported;
  }
  setDelay(ms: number): void {
    this.delayMs = ms;
  }
  private tick(): Promise<void> {
    return this.delayMs
      ? new Promise((resolve) => setTimeout(resolve, this.delayMs))
      : Promise.resolve();
  }
}

const exampleDocument: WorkspaceDocument = {
  version: 1,
  activeProjectId: EXAMPLE_PROJECT.id,
  projects: [structuredClone(EXAMPLE_PROJECT)],
};

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.source).toBe("example");
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    await repository.save(exampleDocument);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.source).toBe("fallback");
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
        { id: 9, title: null },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("reports fallback-only health when IndexedDB fails but the recovery copy is written", async () => {
    const storage = new MemoryStorage();
    storage.writeFailure = "quota";
    const repository = new ProjectRepository(storage);
    const outcome = await repository.save(exampleDocument);
    expect(outcome.primary.state).toBe("quota");
    expect(outcome.fallback.state).toBe("ok");
    expect(healthOf(outcome)).toBe("fallback-only");

    storage.writeFailure = null;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
    expect(loaded.source).toBe("fallback");
  });

  it("reports primary-only health when IndexedDB succeeds but the recovery copy is out of space", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const restore = Storage.prototype.setItem;
    Storage.prototype.setItem = (key: string, value: string) => {
      if (key === "latency-lab.workspace.v1")
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      restore.call(localStorage, key, value);
    };
    try {
      const outcome = await repository.save(exampleDocument);
      expect(outcome.primary.state).toBe("ok");
      expect(outcome.fallback.state).toBe("quota");
      expect(healthOf(outcome)).toBe("primary-only");
      // 主库数据确实完好可读
      const loaded = await repository.load();
      expect(loaded.source).toBe("primary");
      expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    } finally {
      Storage.prototype.setItem = restore;
    }
  });

  it("reports none health with distinct reasons when both layers fail", async () => {
    const storage = new MemoryStorage();
    storage.writeFailure = "error";
    const restore = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    };
    try {
      const outcome = await new ProjectRepository(storage).save(
        exampleDocument,
      );
      expect(outcome.primary.state).toBe("error");
      expect(outcome.fallback.state).toBe("quota");
      expect(healthOf(outcome)).toBe("none");
    } finally {
      Storage.prototype.setItem = restore;
    }
  });

  it("classifies an unsupported browser separately from quota and generic errors", async () => {
    const storage = new MemoryStorage();
    storage.supported = false;
    storage.writeFailure = "unsupported";
    const repository = new ProjectRepository(storage);
    const outcome = await repository.save(exampleDocument);
    expect(outcome.primary.state).toBe("unsupported");
    expect(outcome.fallback.state).toBe("ok");
    expect(healthOf(outcome)).toBe("fallback-only");

    expect(
      classifyStorageError(
        new DOMException("QuotaExceededError", "QuotaExceededError"),
      ),
    ).toBe("quota");
    expect(classifyStorageError(new StorageTimeoutError("X"))).toBe("timeout");
  });

  it("treats a layer that never settles as a timeout instead of hanging forever", async () => {
    const storage = new MemoryStorage();
    storage.writeFailure = "timeout";
    const repository = new ProjectRepository(storage, {
      layerTimeoutMs: 20,
    });
    const outcome = await repository.save(exampleDocument);
    expect(outcome.primary.state).toBe("timeout");
    // 恢复副本不受影响
    expect(outcome.fallback.state).toBe("ok");
    expect(healthOf(outcome)).toBe("fallback-only");
  });

  it("exposes degraded layer capability at load when IndexedDB is unsupported", async () => {
    const storage = new MemoryStorage();
    storage.supported = false;
    const repository = new ProjectRepository(storage);
    const loaded = await repository.load();
    expect(loaded.outcome.primary.state).toBe("unsupported");
    expect(loaded.outcome.fallback.state).toBe("ok");
  });
});

describe("storage presentation", () => {
  const dual = {
    primary: { layer: "primary" as const, state: "ok" as const, detail: "ok" },
    fallback: { layer: "fallback" as const, state: "ok" as const, detail: "ok" },
    durationMs: 1,
  };
  const primaryQuota = {
    ...dual,
    primary: {
      layer: "primary" as const,
      state: "quota" as const,
      detail: "x",
    },
  };
  const fallbackQuota = {
    ...dual,
    fallback: {
      layer: "fallback" as const,
      state: "quota" as const,
      detail: "x",
    },
  };
  const bothFail = {
    primary: {
      layer: "primary" as const,
      state: "error" as const,
      detail: "x",
    },
    fallback: {
      layer: "fallback" as const,
      state: "quota" as const,
      detail: "x",
    },
    durationMs: 1,
  };
  const primaryUnsupported = {
    ...dual,
    primary: {
      layer: "primary" as const,
      state: "unsupported" as const,
      detail: "x",
    },
  };

  it("describes dual success as saved", () => {
    const view = buildStoragePresentation({
      phase: "settled",
      outcome: dual,
    });
    expect(view.label).toBe("已保存");
    expect(view.tone).toBe("ok");
    expect(view.retryable).toBe(false);
  });

  it("describes fallback-only saves as safe-but-degraded with matching wording", () => {
    const view = buildStoragePresentation({
      phase: "settled",
      outcome: primaryQuota,
    });
    expect(view.label).toBe("仅恢复副本已保存");
    expect(view.tone).toBe("warn");
    expect(view.detail).toContain("恢复副本");
    expect(view.detail).toContain("空间不足");
    expect(view.retryable).toBe(true);
  });

  it("warns when only the primary layer survives and no safety net exists", () => {
    const view = buildStoragePresentation({
      phase: "settled",
      outcome: fallbackQuota,
    });
    expect(view.label).toBe("已保存 · 无恢复副本");
    expect(view.tone).toBe("warn");
    expect(view.detail).toContain("兜底");
    expect(view.retryable).toBe(true);
  });

  it("marks double failure as dangerous and not-closed-tab-safe", () => {
    const view = buildStoragePresentation({
      phase: "settled",
      outcome: bothFail,
    });
    expect(view.label).toBe("保存失败");
    expect(view.tone).toBe("danger");
    expect(view.detail).toContain("只保留在本页面");
  });

  it("does not offer retry when the failure is unsupported", () => {
    const view = buildStoragePresentation({
      phase: "settled",
      outcome: primaryUnsupported,
    });
    expect(view.retryable).toBe(false);
    expect(view.detail).toContain("不支持");
  });

  it("shows an in-progress saving presentation while layers are pending", () => {
    const view = buildStoragePresentation({
      phase: "saving",
      outcome: dual,
    });
    expect(view.label).toBe("保存中…");
    expect(view.retryable).toBe(false);
    expect(view.layers.every((layer) => layer.state === "pending")).toBe(true);
  });
});
