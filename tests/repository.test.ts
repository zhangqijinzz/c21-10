import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectRepository,
  summarizeSave,
} from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  async read(): Promise<unknown> {
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

function exampleDocument(): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: EXAMPLE_PROJECT.id,
    projects: [structuredClone(EXAMPLE_PROJECT)],
  };
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await repository.save(document);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
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

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    const document = exampleDocument();
    const report = await repository.save(document);
    expect(report.indexedDb.ok).toBe(false);
    expect(report.recoveryCopy.ok).toBe(true);
    expect(summarizeSave(report)).toBe("degraded");
    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});

describe("save layer reporting", () => {
  beforeEach(() => localStorage.clear());

  it("reports saved when both layers accept the document", async () => {
    const storage = new MemoryStorage();
    const report = await new ProjectRepository(storage).save(exampleDocument());
    expect(report.indexedDb.ok).toBe(true);
    expect(report.recoveryCopy.ok).toBe(true);
    expect(summarizeSave(report)).toBe("saved");
  });

  it("reports degraded with quota reason when the recovery copy cannot be written", async () => {
    const storage = new MemoryStorage();
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("storage is full", "QuotaExceededError");
      });
    try {
      const report = await new ProjectRepository(storage).save(
        exampleDocument(),
      );
      expect(report.indexedDb.ok).toBe(true);
      expect(report.recoveryCopy).toEqual({
        ok: false,
        failure: expect.objectContaining({ reason: "quota" }),
      });
      expect(summarizeSave(report)).toBe("degraded");
    } finally {
      setItem.mockRestore();
    }
  });

  it("reports failed when both layers reject the document", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("storage is full", "QuotaExceededError");
      });
    try {
      const report = await new ProjectRepository(storage).save(
        exampleDocument(),
      );
      expect(report.indexedDb.ok).toBe(false);
      expect(report.recoveryCopy.ok).toBe(false);
      expect(summarizeSave(report)).toBe("failed");
    } finally {
      setItem.mockRestore();
    }
  });

  it("classifies an unsupported browser database instead of a generic failure", async () => {
    const storage = new MemoryStorage();
    storage.write = () => Promise.reject(new Error("浏览器不支持 IndexedDB"));
    const report = await new ProjectRepository(storage).save(exampleDocument());
    expect(report.indexedDb).toEqual({
      ok: false,
      failure: expect.objectContaining({ reason: "unsupported" }),
    });
    expect(report.recoveryCopy.ok).toBe(true);
    expect(summarizeSave(report)).toBe("degraded");
  });

  it("times out an unresponsive layer and still writes the recovery copy", async () => {
    const storage = new MemoryStorage();
    storage.write = () => new Promise<void>(() => {});
    const report = await new ProjectRepository(storage, 20).save(
      exampleDocument(),
    );
    expect(report.indexedDb).toEqual({
      ok: false,
      failure: expect.objectContaining({ reason: "timeout" }),
    });
    expect(report.recoveryCopy.ok).toBe(true);
    expect(summarizeSave(report)).toBe("degraded");
  });

  it("falls back to the recovery copy when the database stops responding on load", async () => {
    const storage = new MemoryStorage();
    const writer = new ProjectRepository(storage);
    await writer.save(exampleDocument());
    storage.read = () => new Promise<unknown>(() => {});
    const loaded = await new ProjectRepository(storage, 20).load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });
});
