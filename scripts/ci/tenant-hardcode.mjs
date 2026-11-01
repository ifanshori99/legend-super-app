import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

// TEN-07 is a static heuristic, not a substitute for human review. It checks
// literal comparisons against tenant identifiers in branch conditions.
export function findTenantBranches(source, filename = "source.ts") {
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const aliases = new Set();
  const namePattern =
    /^(?:tenant(?:id|name|domain|hostname|slug)|hostname|host)$/i;
  const propPattern = /^(?:id|name|domain|hostname|slug)$/i;
  function tenantValue(node) {
    if (ts.isParenthesizedExpression(node)) return tenantValue(node.expression);
    if (ts.isIdentifier(node))
      return namePattern.test(node.text) || aliases.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return (
        namePattern.test(node.name.text) ||
        (propPattern.test(node.name.text) &&
          /tenant/i.test(node.expression.getText(tree))) ||
        /^(?:hostname|host)$/i.test(node.name.text)
      );
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      return (
        namePattern.test(node.argumentExpression.text) ||
        (propPattern.test(node.argumentExpression.text) &&
          /tenant/i.test(node.expression.getText(tree)))
      );
    }
    return false;
  }
  function literal(node) {
    return (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
    );
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && tenantValue(node.initializer))
        aliases.add(node.name.text);
      if (
        ts.isObjectBindingPattern(node.name) &&
        /tenant/i.test(node.initializer.getText(tree))
      ) {
        for (const entry of node.name.elements) {
          const original =
            entry.propertyName?.getText(tree) ?? entry.name.getText(tree);
          if (propPattern.test(original) && ts.isIdentifier(entry.name))
            aliases.add(entry.name.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const findings = [];
  function report(node) {
    const position = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    findings.push({ line: position.line + 1, column: position.character + 1 });
  }
  function inspectCondition(node) {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ((tenantValue(node.left) && literal(node.right)) ||
        (literal(node.left) && tenantValue(node.right)))
    )
      report(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.expression.expression.elements.some(literal) &&
      node.arguments.some(tenantValue)
    )
      report(node);
    ts.forEachChild(node, inspectCondition);
  }
  function visit(node) {
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      inspectCondition(node.expression ?? node.condition);
    } else if (ts.isSwitchStatement(node) && tenantValue(node.expression)) {
      for (const clause of node.caseBlock.clauses)
        if (ts.isCaseClause(clause) && literal(clause.expression))
          report(clause);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        ![
          "node_modules",
          "dist",
          ".output",
          ".tanstack",
          ".turbo",
          "drizzle",
          "test",
          "tests",
          "__tests__",
        ].includes(entry.name)
      )
        result.push(...(await sourceFiles(file)));
    } else if (
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) &&
      entry.name !== "routeTree.gen.ts"
    )
      result.push(file);
  }
  return result;
}

async function main() {
  let count = 0;
  for (const root of ["apps", "packages"]) {
    for (const file of await sourceFiles(root)) {
      for (const finding of findTenantBranches(
        await readFile(file, "utf8"),
        file,
      )) {
        console.error(
          `${file}:${finding.line}:${finding.column}: TEN-07 tenant-specific branch`,
        );
        count++;
      }
    }
  }
  if (count) process.exitCode = 1;
  else console.log("TEN-07: no tenant-specific branches found");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
