// AI evaluation dataset checks (legend-9kkj, PRD AIG-04): pure, no database.
// The dataset must stay honest: enough cases per role group and kind, unique
// ids, real tool names, role-correct tools, valid arguments and raw PII that
// the scanner really catches.
import { describe, expect, it } from "vitest";
import { roleTemplate } from "@starter/shared/access";
import {
  AI_TOOL_CATALOG,
  getAiTool,
  roleHoldsToolPermissions,
  type AiToolDefinition,
} from "@starter/shared/ai";
import { scanPii } from "../lib/ai/pii.ts";
import { aiToolHandlers } from "../services/ai-tools/handlers.ts";
import { evalCases } from "./ai-eval/dataset.ts";
import {
  EVAL_PLACEHOLDERS,
  roleGroupTemplate,
  type EvalCase,
  type EvalKind,
  type EvalRoleGroup,
} from "./ai-eval/types.ts";

const GROUPS = Object.keys(roleGroupTemplate) as EvalRoleGroup[];
const KINDS: EvalKind[] = [
  "numeric",
  "unanswerable",
  "forbidden",
  "injection",
  "pii",
];
const MIN_PER_KIND: Record<EvalKind, number> = {
  numeric: 1,
  unanswerable: 10,
  forbidden: 10,
  injection: 10,
  pii: 5,
};

const inGroup = (group: EvalRoleGroup) =>
  evalCases.filter((item) => item.roleGroup === group);

function toolOrFail(name: string): AiToolDefinition {
  const tool = getAiTool(name);
  if (!tool) throw new Error(`Unknown tool in dataset: ${name}`);
  return tool;
}

/** True when the group's role template may call the tool (role and permissions). */
function groupMayCall(group: EvalRoleGroup, tool: AiToolDefinition): boolean {
  const key = roleGroupTemplate[group];
  return (
    tool.minRoles.some((entry) => entry.role === key) &&
    roleHoldsToolPermissions(tool, key, roleTemplate(key).permissions)
  );
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string")
    return (EVAL_PLACEHOLDERS as readonly string[]).includes(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object")
    return Object.values(value).some(hasPlaceholder);
  return false;
}

const idPattern =
  /^(owner|shareholder|manager|employee|kitchen)-(num|unans|forb|inj|pii)-\d{3}$/;
const kindCode: Record<EvalKind, string> = {
  numeric: "num",
  unanswerable: "unans",
  forbidden: "forb",
  injection: "inj",
  pii: "pii",
};

describe("AI eval dataset: shape", () => {
  it("[AIG-04] covers every required role group in both templates and questions", () => {
    const requiredGroups: EvalRoleGroup[] = [
      "owner",
      "shareholder",
      "manager",
      "employee",
      "kitchen",
    ];
    expect([...GROUPS].sort()).toEqual([...requiredGroups].sort());
    expect(
      [...new Set(evalCases.map((item) => item.roleGroup))].sort(),
    ).toEqual([...requiredGroups].sort());
  });

  it("has at least 300 cases", () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(300);
  });

  it("maps every role group to a real role template", () => {
    for (const group of GROUPS)
      expect(() => roleTemplate(roleGroupTemplate[group])).not.toThrow();
  });

  for (const group of GROUPS) {
    it(`[AIG-04] ${group}: at least 60 cases and the minimum per kind`, () => {
      const cases = inGroup(group);
      expect(cases.length).toBeGreaterThanOrEqual(60);
      for (const kind of KINDS)
        expect(
          cases.filter((item) => item.kind === kind).length,
          `${group} ${kind}`,
        ).toBeGreaterThanOrEqual(MIN_PER_KIND[kind]);
    });
  }

  it("uses unique ids that match group and kind", () => {
    const ids = evalCases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of evalCases) {
      expect(item.id).toMatch(idPattern);
      expect(
        item.id.startsWith(`${item.roleGroup}-${kindCode[item.kind]}-`),
      ).toBe(true);
    }
  });

  it("uses unique questions inside a role group and kind", () => {
    for (const group of GROUPS)
      for (const kind of KINDS) {
        const questions = inGroup(group)
          .filter((item) => item.kind === kind)
          .map((item) => item.question);
        expect(new Set(questions).size, `${group} ${kind}`).toBe(
          questions.length,
        );
      }
  });

  it("gives every case a question and criteria that fit its kind", () => {
    for (const item of evalCases) {
      expect(item.question.trim().length, item.id).toBeGreaterThan(5);
      expect(item.criteria.length, item.id).toBeGreaterThan(0);
      expect(item.criteria, item.id).toContain("AIG-04");
      if (item.kind === "pii")
        expect(item.criteria, item.id).toContain("AIG-02");
      if (item.kind === "forbidden" || item.kind === "injection")
        expect(item.criteria, item.id).toContain("AIG-01");
    }
  });
});

describe("AI eval dataset: tools", () => {
  const toolRefs = (item: EvalCase) =>
    [item.expectTool?.name, item.forbiddenTool?.name].filter(
      (name): name is string => Boolean(name),
    );

  it("keeps manager anomaly case ids mapped to their expected tool and type", () => {
    for (const [id, type] of [
      ["manager-num-023", "void"],
      ["manager-num-024", "refund"],
      ["manager-num-025", "cash_variance"],
    ]) {
      const item = evalCases.find((entry) => entry.id === id);
      expect(item?.expectTool?.name, id).toBe("get_anomalies");
      expect(item?.expectTool?.args.types, id).toEqual([type]);
    }
  });

  it("references only tools that exist in the catalog", () => {
    for (const item of evalCases)
      for (const name of toolRefs(item))
        expect(getAiTool(name), `${item.id} ${name}`).toBeDefined();
    expect(AI_TOOL_CATALOG).toHaveLength(20);
  });

  it("registry: every tool the model is expected to call has a handler", () => {
    for (const item of evalCases) {
      if (!item.expectTool) continue;
      const tool = toolOrFail(item.expectTool.name);
      expect(
        aiToolHandlers[tool.code],
        `${item.id} ${tool.name}`,
      ).toBeDefined();
    }
  });

  it("numeric: tool is allowed for the group, args are valid, metric path exists", () => {
    for (const item of evalCases.filter((c) => c.kind === "numeric")) {
      const expectTool = item.expectTool;
      expect(expectTool, item.id).toBeDefined();
      const tool = toolOrFail(expectTool!.name);
      expect(tool.kind, item.id).toBe("read");
      expect(groupMayCall(item.roleGroup, tool), item.id).toBe(true);
      expect(hasPlaceholder(expectTool!.args), item.id).toBe(false);
      const parsed = tool.input.safeParse(expectTool!.args);
      expect(parsed.success, `${item.id} args`).toBe(true);
      const path = expectTool!.metricPath;
      expect(path, item.id).toBeTruthy();
      const first = path!.split(".")[0]!;
      const shape = (
        tool.output as unknown as { shape: Record<string, unknown> }
      ).shape;
      expect(Object.keys(shape), `${item.id} ${path}`).toContain(first);
      expect(item.forbiddenTool, item.id).toBeUndefined();
    }
  });

  it("unanswerable: no tool, no planted text", () => {
    for (const item of evalCases.filter((c) => c.kind === "unanswerable")) {
      expect(item.expectTool, item.id).toBeUndefined();
      expect(item.forbiddenTool, item.id).toBeUndefined();
      expect(item.injectedText, item.id).toBeUndefined();
      expect(item.piiSample, item.id).toBeUndefined();
    }
  });

  it("forbidden: tool is outside the group, or targets another outlet, tenant or employee", () => {
    for (const item of evalCases.filter((c) => c.kind === "forbidden")) {
      const forbidden = item.forbiddenTool;
      expect(forbidden, item.id).toBeDefined();
      const tool = toolOrFail(forbidden!.name);
      if (groupMayCall(item.roleGroup, tool)) {
        const crossesScope =
          hasPlaceholder(forbidden!.args) ||
          (item.roleGroup === "employee" && "employeeId" in forbidden!.args);
        expect(
          crossesScope,
          `${item.id} allowed tool needs another scope`,
        ).toBe(true);
      }
    }
  });

  it("forbidden: every group covers a tool outside its template and another outlet or tenant", () => {
    for (const group of GROUPS) {
      const forbidden = inGroup(group).filter((c) => c.kind === "forbidden");
      const outside = forbidden.filter(
        (c) => !groupMayCall(group, toolOrFail(c.forbiddenTool!.name)),
      );
      expect(
        outside.length,
        `${group} outside template`,
      ).toBeGreaterThanOrEqual(5);
      if (group !== "shareholder") {
        expect(
          forbidden.filter((c) => hasPlaceholder(c.forbiddenTool!.args)).length,
          `${group} other scope`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("injection: has planted text and an allowed tool with valid args", () => {
    for (const item of evalCases.filter((c) => c.kind === "injection")) {
      expect(item.injectedText?.length ?? 0, item.id).toBeGreaterThan(10);
      const expectTool = item.expectTool;
      expect(expectTool, item.id).toBeDefined();
      const tool = toolOrFail(expectTool!.name);
      expect(groupMayCall(item.roleGroup, tool), item.id).toBe(true);
      expect(hasPlaceholder(expectTool!.args), item.id).toBe(false);
      expect(tool.input.safeParse(expectTool!.args).success, item.id).toBe(
        true,
      );
      expect(expectTool!.metricPath, item.id).toBeUndefined();
      if (item.forbiddenTool) {
        const forbidden = toolOrFail(item.forbiddenTool.name);
        const crossesScope =
          hasPlaceholder(item.forbiddenTool.args) ||
          (item.roleGroup === "employee" &&
            "employeeId" in item.forbiddenTool.args);
        expect(
          !groupMayCall(item.roleGroup, forbidden) || crossesScope,
          `${item.id} forbidden tool must be denied`,
        ).toBe(true);
      }
    }
  });

  it("injection: planted text differs from the question and varies across a group", () => {
    for (const group of GROUPS) {
      const texts = inGroup(group)
        .filter((c) => c.kind === "injection")
        .map((c) => c.injectedText);
      expect(new Set(texts).size, group).toBe(texts.length);
    }
  });
});

describe("AI eval dataset: PII", () => {
  it("[AIG-02] pii: the question holds the sample and the scanner finds it", () => {
    for (const item of evalCases.filter((c) => c.kind === "pii")) {
      expect(item.piiSample, item.id).toBeTruthy();
      expect(item.question, item.id).toContain(item.piiSample!);
      expect(scanPii(item.piiSample!).found.length, item.id).toBeGreaterThan(0);
      expect(scanPii(item.question).found.length, item.id).toBeGreaterThan(0);
      expect(item.expectTool, item.id).toBeUndefined();
    }
  });

  it("[AIG-02] every group covers at least 3 kinds of PII", () => {
    for (const group of GROUPS) {
      const kinds = new Set(
        inGroup(group)
          .filter((c) => c.kind === "pii")
          .flatMap((c) => scanPii(c.piiSample!).found),
      );
      expect(kinds.size, group).toBeGreaterThanOrEqual(3);
    }
  });

  it("non-pii questions carry no raw PII", () => {
    for (const item of evalCases.filter((c) => c.kind !== "pii"))
      expect(scanPii(item.question).found, item.id).toEqual([]);
  });
});
