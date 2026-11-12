// legend-ga0n / OPS-01: durable, scoped checklist answers may be replayed,
// but an attempt is never presented as a server save before acknowledgement.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

const moduleUrl = new URL(
  "../apps/web/src/features/operations-checklist/queue.ts",
  import.meta.url,
);
const queueModule = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};
const scope = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  outletId: "00000000-0000-4000-8000-000000000003",
};
const otherOutlet = {
  ...scope,
  outletId: "00000000-0000-4000-8000-000000000004",
};
const otherUser = {
  ...scope,
  userId: "00000000-0000-4000-8000-000000000005",
};
const otherTenant = {
  ...scope,
  tenantId: "00000000-0000-4000-8000-000000000006",
};
const NOW = "2030-01-15T03:00:00.000Z";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function submission(key, targetScope = scope) {
  return {
    scope: targetScope,
    runId: "00000000-0000-4000-8000-000000008202",
    itemId: "00000000-0000-4000-8000-000000008302",
    body: {
      status: "done",
      numberValue: null,
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      idempotencyKey: key,
      expectedActorUserId: targetScope.userId,
    },
  };
}

function createLock() {
  let tail = Promise.resolve();
  return (work) => {
    const next = tail.then(work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness({
  storage = memoryStorage(),
  send,
  active = scope,
  withLock = createLock(),
} = {}) {
  assert.equal(
    typeof queueModule.createChecklistAnswerQueue,
    "function",
    "legend-ga0n must provide the durable checklist answer queue",
  );
  const sent = [];
  let activeScope = active;
  const queue = queueModule.createChecklistAnswerQueue({
    storage,
    withLock,
    send: async (entry) => {
      sent.push(structuredClone(entry));
      return send?.(entry);
    },
    getActiveScope: () => activeScope,
    now: () => NOW,
  });
  return {
    queue,
    storage,
    sent,
    setActive: (next) => {
      activeScope = next;
    },
  };
}

test("legend-ga0n OPS-01 persists the original answer and key across a page reload", async () => {
  const { queue, storage } = harness();
  const input = submission("offline-checklist-answer-0001");
  const original = structuredClone(input);
  await queue.enqueue(input);
  input.body.note = "A later local edit must not change an enqueued attempt";

  const reloaded = harness({ storage }).queue;
  const [entry] = reloaded.list(scope);
  assert.deepEqual(entry.body, original.body);
  assert.deepEqual(entry.scope, scope);
  assert.equal(entry.runId, original.runId);
  assert.equal(entry.itemId, original.itemId);
  assert.equal(entry.idempotencyKey, original.body.idempotencyKey);
  assert.equal(entry.queuedAt, NOW);
});

test("legend-ga0n OPS-01 deduplicates identical retries and rejects key reuse with another answer", async () => {
  const { queue } = harness();
  const input = submission("offline-checklist-answer-0002");
  await queue.enqueue(input);
  await queue.enqueue(structuredClone(input));
  assert.equal(queue.list(scope).length, 1);
  await assert.rejects(() =>
    queue.enqueue({
      ...input,
      body: { ...input.body, note: "Changed answer" },
    }),
  );
  assert.deepEqual(queue.list(scope)[0].body, input.body);
});

test("legend-ga0n TEN-03 the queue binds the replay actor to the captured scope instead of a supplied body actor", async () => {
  const h = harness();
  const input = submission("offline-bound-actor-answer-0001");
  input.body.expectedActorUserId = otherUser.userId;
  await h.queue.enqueue(input);
  assert.equal(h.queue.list(scope)[0].body.expectedActorUserId, scope.userId);
  await h.queue.replay(scope);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].body.expectedActorUserId, scope.userId);
});

test("legend-ga0n TEN-03 a legacy queued answer binds its stored actor before replay and never the current session actor", async () => {
  const { queue, storage } = harness();
  await queue.enqueue(submission("offline-legacy-actor-answer-0001"));
  const persisted = JSON.parse(
    storage.getItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY),
  );
  delete persisted.entries[0].body.expectedActorUserId;
  storage.setItem(
    queueModule.CHECKLIST_ANSWER_QUEUE_KEY,
    JSON.stringify(persisted),
  );
  const reloaded = harness({ storage, active: otherUser });
  await reloaded.queue.replay(scope);
  assert.equal(reloaded.sent.length, 0);
  reloaded.setActive(scope);
  await reloaded.queue.replay(scope);
  assert.equal(reloaded.sent.length, 1);
  assert.equal(reloaded.sent[0].body.expectedActorUserId, scope.userId);
});

test("legend-ga0n TEN-03 a persisted actor that conflicts with the captured scope is refused without discarding the answer", async () => {
  const { queue, storage } = harness();
  await queue.enqueue(submission("offline-corrupt-actor-answer-0001"));
  const persisted = JSON.parse(
    storage.getItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY),
  );
  persisted.entries[0].body.expectedActorUserId = otherUser.userId;
  const corrupt = JSON.stringify(persisted);
  storage.setItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY, corrupt);
  const reloaded = harness({ storage });
  assert.throws(() => reloaded.queue.list(scope));
  await assert.rejects(() => reloaded.queue.replay(scope));
  assert.equal(reloaded.sent.length, 0);
  assert.equal(
    storage.getItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY),
    corrupt,
  );
});

test("legend-ga0n TEN-03 only lists and replays the active tenant, user and outlet", async () => {
  const h = harness();
  for (const [index, target] of [
    scope,
    otherOutlet,
    otherUser,
    otherTenant,
  ].entries()) {
    await h.queue.enqueue(submission(`offline-scope-answer-${index}`, target));
  }
  assert.equal(h.queue.list(scope).length, 1);
  await h.queue.replay(otherOutlet);
  assert.equal(h.sent.length, 0, "an inactive outlet must never be sent");
  await h.queue.replay(scope);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].scope, scope);
  assert.equal(h.queue.list(scope).length, 0);
  for (const target of [otherOutlet, otherUser, otherTenant]) {
    assert.equal(h.queue.list(target).length, 1);
  }
});

test("legend-ga0n TEN-03 revalidates the session before every queued answer", async () => {
  let h;
  h = harness({
    send: async () => {
      h.setActive(otherUser);
    },
  });
  await h.queue.enqueue(submission("offline-session-answer-0001"));
  await h.queue.enqueue(submission("offline-session-answer-0002"));
  await h.queue.replay(scope);
  assert.equal(h.sent.length, 1);
  assert.equal(h.queue.list(scope).length, 1);
  assert.equal(
    h.queue.list(scope)[0].idempotencyKey,
    "offline-session-answer-0002",
  );
});

test("legend-ga0n OPS-01 replays in order and retains a failed answer with the original key", async () => {
  let fail = true;
  const h = harness({
    send: async () => {
      if (fail) throw new Error("Connection lost after the server received it");
    },
  });
  await h.queue.enqueue(submission("offline-retry-answer-0001"));
  await h.queue.enqueue(submission("offline-retry-answer-0002"));
  await h.queue.replay(scope);
  assert.equal(h.sent.length, 1, "later answers wait for the failed attempt");
  assert.equal(h.queue.list(scope).length, 2);
  assert.ok(h.queue.list(scope)[0].error, "a retained failure must be visible");

  fail = false;
  await h.queue.replay(scope);
  assert.deepEqual(
    h.sent.map((entry) => entry.body.idempotencyKey),
    [
      "offline-retry-answer-0001",
      "offline-retry-answer-0001",
      "offline-retry-answer-0002",
    ],
  );
  assert.equal(h.queue.list(scope).length, 0);
});

test("legend-ga0n OPS-01 a server validation failure remains visible and is never discarded as saved", async () => {
  const h = harness({
    send: async () => {
      throw Object.assign(new Error("Run is already closed"), { status: 409 });
    },
  });
  await h.queue.enqueue(submission("offline-conflict-answer-0001"));
  await h.queue.replay(scope);
  const [entry] = h.queue.list(scope);
  assert.equal(entry.idempotencyKey, "offline-conflict-answer-0001");
  assert.ok(entry.error);
});

test("562 OPS-01 a permanent answer conflict retains its local snapshot and lets an independent answer reach the server", async () => {
  const conflict = submission("offline-permanent-conflict-answer-0001");
  conflict.body.note = "Local opening temperature was 4 degrees";
  conflict.body.numberValue = "4";
  const independent = submission("offline-independent-answer-0002");
  independent.itemId = "00000000-0000-4000-8000-000000008303";
  const original = structuredClone(conflict);
  const h = harness({
    send: async (entry) => {
      if (entry.idempotencyKey === conflict.body.idempotencyKey)
        throw new ApiError(
          409,
          "CHECKLIST_ANSWER_CONFLICT",
          "Another answer is already saved on the server",
        );
    },
  });
  await h.queue.enqueue(conflict);
  await h.queue.enqueue(independent);

  assert.deepEqual(await h.queue.replay(scope), { sent: 1, pending: 1 });
  assert.deepEqual(
    h.sent.map((entry) => entry.idempotencyKey),
    [conflict.body.idempotencyKey, independent.body.idempotencyKey],
  );
  assert.equal(h.queue.list(scope).length, 0);
  const [held] = h.queue.listConflicts(scope);
  assert.deepEqual(held.body, original.body);
  assert.deepEqual(held.scope, original.scope);
  assert.equal(held.itemId, original.itemId);
  assert.equal(held.runId, original.runId);
  assert.ok(held.error, "the local answer needs visible resolution");

  const reloaded = harness({ storage: h.storage });
  assert.deepEqual(reloaded.queue.listConflicts(scope)[0].body, original.body);
  assert.deepEqual(await reloaded.queue.replay(scope), {
    sent: 0,
    pending: 1,
  });
  assert.equal(reloaded.sent.length, 0, "replay cannot overwrite the server");
});

test("562 OPS-01 discarding a conflict only removes the chosen local answer in its active scope", async () => {
  const key = "offline-discard-conflict-answer-0001";
  const h = harness({
    send: async () => {
      throw new ApiError(
        409,
        "CHECKLIST_ANSWER_CONFLICT",
        "Another answer is already saved on the server",
      );
    },
  });
  await h.queue.enqueue(submission(key));
  await h.queue.enqueue(submission(key, otherOutlet));
  await h.queue.replay(scope);
  h.setActive(otherOutlet);
  await h.queue.replay(otherOutlet);

  h.setActive(scope);
  await h.queue.discardConflict(scope, key);
  assert.equal(h.queue.listConflicts(scope).length, 0);
  assert.equal(h.queue.listConflicts(otherOutlet).length, 1);
  assert.deepEqual(await h.queue.replay(scope), { sent: 0, pending: 0 });
  assert.equal(h.sent.length, 2, "discard must never submit a replacement");
});

test("562 OPS-01 answers for a conflicted item require resolution while unrelated items continue", async () => {
  const conflict = submission("offline-same-item-conflict-0001");
  const sameItem = submission("offline-same-item-conflict-0002");
  sameItem.body.note = "A later local answer for the same server item";
  const independent = submission("offline-other-item-after-conflict-0003");
  independent.itemId = "00000000-0000-4000-8000-000000008303";
  const h = harness({
    send: async (entry) => {
      if (entry.itemId === conflict.itemId)
        throw new ApiError(409, "CHECKLIST_ANSWER_CONFLICT", "Answer conflict");
    },
  });
  await h.queue.enqueue(conflict);
  await h.queue.enqueue(sameItem);
  await h.queue.enqueue(independent);

  assert.deepEqual(await h.queue.replay(scope), { sent: 1, pending: 2 });
  assert.deepEqual(
    h.sent.map((entry) => entry.idempotencyKey),
    [conflict.body.idempotencyKey, independent.body.idempotencyKey],
  );
  assert.deepEqual(
    h.queue.listConflicts(scope).map((entry) => entry.body.note),
    [conflict.body.note, sameItem.body.note],
  );
  await assert.rejects(() =>
    h.queue.enqueue(submission("offline-new-key-for-conflicted-item-0004")),
  );
});

test("562 OPS-01 a conflict message without the permanent API code still waits for retry", async () => {
  const h = harness({
    send: async () => {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "CHECKLIST_ANSWER_CONFLICT may be unavailable until retry",
      );
    },
  });
  await h.queue.enqueue(submission("offline-transient-conflict-message-0001"));
  const independent = submission("offline-after-transient-message-0002");
  independent.itemId = "00000000-0000-4000-8000-000000008303";
  await h.queue.enqueue(independent);

  assert.deepEqual(await h.queue.replay(scope), { sent: 0, pending: 2 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.queue.list(scope).length, 2);
  assert.equal(h.queue.listConflicts(scope).length, 0);
});

test("562 OPS-01 a conflict cannot be lost when saving the resolution list fails", async () => {
  const backing = memoryStorage();
  let blocked = false;
  const storage = {
    getItem: backing.getItem,
    setItem: (key, value) => {
      if (blocked) throw new Error("Device storage full");
      backing.setItem(key, value);
    },
  };
  const h = harness({
    storage,
    send: async () => {
      throw new ApiError(
        409,
        "CHECKLIST_ANSWER_CONFLICT",
        "Another answer is already saved on the server",
      );
    },
  });
  const input = submission("offline-undurable-conflict-answer-0001");
  input.body.note = "Keep this local evidence";
  await h.queue.enqueue(input);
  const before = storage.getItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY);
  blocked = true;

  await assert.rejects(() => h.queue.replay(scope));
  assert.equal(storage.getItem(queueModule.CHECKLIST_ANSWER_QUEUE_KEY), before);
  assert.deepEqual(
    harness({ storage: backing }).queue.list(scope)[0].body,
    input.body,
  );
});

test(
  "legend-ga0n OPS-01 concurrent replay calls send each pending answer once",
  { timeout: 5000 },
  async () => {
    const started = deferred();
    const wait = deferred();
    const h = harness({
      send: () => {
        started.resolve();
        return wait.promise;
      },
    });
    await h.queue.enqueue(submission("offline-concurrent-answer-0001"));
    const first = h.queue.replay(scope);
    const second = h.queue.replay(scope);
    await started.promise;
    assert.equal(h.sent.length, 1);
    wait.resolve();
    await Promise.all([first, second]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.queue.list(scope).length, 0);
  },
);

test(
  "legend-ga0n OPS-01 an answer queued during a send is preserved and replayed in order",
  { timeout: 5000 },
  async () => {
    const started = deferred();
    const wait = deferred();
    let calls = 0;
    const h = harness({
      send: async () => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await wait.promise;
        }
      },
    });
    await h.queue.enqueue(submission("offline-during-send-answer-0001"));
    const replay = h.queue.replay(scope);
    await started.promise;
    assert.equal(h.sent.length, 1);
    await h.queue.enqueue(submission("offline-during-send-answer-0002"));
    await h.queue.enqueue(
      submission("offline-during-send-other-outlet", otherOutlet),
    );
    wait.resolve();
    await replay;
    assert.deepEqual(
      h.sent.map((entry) => entry.idempotencyKey),
      ["offline-during-send-answer-0001", "offline-during-send-answer-0002"],
    );
    assert.equal(h.queue.list(scope).length, 0);
    assert.equal(h.queue.list(otherOutlet).length, 1);
  },
);

test(
  "legend-ga0n OPS-01 a failed send cannot overwrite an answer queued while it was awaiting",
  { timeout: 5000 },
  async () => {
    const started = deferred();
    const wait = deferred();
    const h = harness({
      send: () => {
        started.resolve();
        return wait.promise;
      },
    });
    await h.queue.enqueue(submission("offline-during-failure-answer-0001"));
    const replay = h.queue.replay(scope);
    await started.promise;
    await h.queue.enqueue(submission("offline-during-failure-answer-0002"));
    wait.reject(new Error("Connection lost"));
    await replay;
    const entries = h.queue.list(scope);
    assert.deepEqual(
      entries.map((entry) => entry.idempotencyKey),
      [
        "offline-during-failure-answer-0001",
        "offline-during-failure-answer-0002",
      ],
    );
    assert.ok(entries[0].error);
    assert.equal(h.sent.length, 1);
  },
);

test(
  "legend-ga0n OPS-01 separate queue factories share atomic storage mutations without holding the lock across network sends",
  { timeout: 5000 },
  async () => {
    const storage = memoryStorage();
    const serialize = createLock();
    const mutationGate = deferred();
    const bothRequestedLock = deferred();
    let lockRequests = 0;
    const withLock = (work) => {
      lockRequests += 1;
      if (lockRequests === 2) bothRequestedLock.resolve();
      return serialize(async () => {
        await mutationGate.promise;
        return work();
      });
    };
    const started = deferred();
    const network = deferred();
    let calls = 0;
    const firstFactory = harness({
      storage,
      withLock,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await network.promise;
        }
      },
    });
    const secondFactory = harness({ storage, withLock });

    const firstEnqueue = firstFactory.queue.enqueue(
      submission("offline-shared-lock-answer-0001"),
    );
    const secondEnqueue = secondFactory.queue.enqueue(
      submission("offline-shared-lock-answer-0002"),
    );
    await bothRequestedLock.promise;
    assert.equal(
      firstFactory.queue.list(scope).length,
      0,
      "storage must remain unchanged until the shared lock is acquired",
    );
    mutationGate.resolve();
    await Promise.all([firstEnqueue, secondEnqueue]);
    assert.equal(firstFactory.queue.list(scope).length, 2);

    const replay = firstFactory.queue.replay(scope);
    await started.promise;
    await secondFactory.queue.enqueue(
      submission("offline-shared-lock-answer-0003"),
    );
    await secondFactory.queue.enqueue(
      submission("offline-shared-lock-other-outlet", otherOutlet),
    );
    network.resolve();
    await replay;
    assert.deepEqual(
      firstFactory.sent.map((entry) => entry.idempotencyKey),
      [
        "offline-shared-lock-answer-0001",
        "offline-shared-lock-answer-0002",
        "offline-shared-lock-answer-0003",
      ],
    );
    assert.equal(secondFactory.queue.list(scope).length, 0);
    assert.equal(secondFactory.queue.list(otherOutlet).length, 1);
  },
);

test("legend-ga0n OPS-01 queue overflow rejects the new answer without losing the oldest", async () => {
  const h = harness();
  for (let index = 0; index < 100; index += 1) {
    await h.queue.enqueue(submission(`offline-bounded-answer-${index}`));
  }
  await assert.rejects(() =>
    h.queue.enqueue(submission("offline-bounded-answer-overflow")),
  );
  assert.equal(h.queue.list(scope).length, 100);
  assert.equal(
    h.queue.list(scope)[0].idempotencyKey,
    "offline-bounded-answer-0",
  );
  await h.queue.enqueue(
    submission("offline-bounded-other-outlet", otherOutlet),
  );
  assert.equal(h.queue.list(otherOutlet).length, 1);
});

test("legend-ga0n OPS-01 unavailable storage fails visibly and preserves existing entries", async () => {
  const backing = memoryStorage();
  let blocked = false;
  const storage = {
    getItem: backing.getItem,
    setItem: (key, value) => {
      if (blocked) throw new Error("Device storage full");
      backing.setItem(key, value);
    },
  };
  const h = harness({ storage });
  await h.queue.enqueue(submission("offline-durable-answer-0001"));
  blocked = true;
  await assert.rejects(() =>
    h.queue.enqueue(submission("offline-durable-answer-0002")),
  );
  assert.deepEqual(
    harness({ storage: backing })
      .queue.list(scope)
      .map((entry) => entry.idempotencyKey),
    ["offline-durable-answer-0001"],
  );
});
