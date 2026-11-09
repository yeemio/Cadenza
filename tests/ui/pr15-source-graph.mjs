import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function source(file) { return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) }
function resolveSource(root, from, specifier) {
  const alias = { '@cadenza/ui': 'packages/ui/src/index.ts', '@cadenza/contracts': 'packages/contracts/src/index.ts' }
  const start = alias[specifier] ? path.join(root, alias[specifier]) : specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null
  if (!start) return null
  return [start, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'].map((suffix) => start + suffix)]
    .find((file) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(file)) ?? null
}
export function staticPageGraph(root, app) {
  const pending = [path.join(root, 'apps', app, 'src/App.tsx')], visited = new Set(), pages = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)
    if (/\/src\/(?:p[234]\/)?pages\//.test(file.split(path.sep).join('/'))) pages.add(path.relative(root, file).split(path.sep).join('/'))
    for (const node of source(file).statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || node.isTypeOnly || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue
      if (ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly ||
        (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)))) continue
      const next = resolveSource(root, file, node.moduleSpecifier.text)
      if (next) pending.push(next)
    }
  }
  return { filesVisited: visited.size, staticPageModules: [...pages].sort(), meaning: 'Static TypeScript import graph only, not measured production bytes or browser performance.' }
}
function property(node, name) {
  const item = node.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText().replaceAll("'", '').replaceAll('"', '') === name)
  return item?.initializer
}
function jsxProperty(node, name) {
  const item = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.text === name)
  return item?.initializer
}
function jsxElement(node) {
  if (ts.isJsxExpression(node)) node = node.expression
  if (!node || !(ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node))) return null
  const start = ts.isJsxElement(node) ? node.openingElement : node
  const redirect = jsxProperty(start, 'to')
  return { component: start.tagName.getText(), redirect: redirect && ts.isStringLiteral(redirect) ? redirect.text : null }
}
export function routeContract(root, app) {
  const routes = []
  for (const relative of ['src/App.tsx', 'src/p2/mount.tsx', 'src/p3/mount.tsx', 'src/p4/mount.tsx']) {
    const file = path.join(root, 'apps', app, relative), ast = source(file)
    function visit(node) {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === 'Route') {
        const routePath = jsxProperty(node, 'path'), element = jsxProperty(node, 'element')
        const index = node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.text === 'index')
        if (element && ((routePath && ts.isStringLiteral(routePath)) || index)) routes.push({ path: index ? '<index>' : routePath.text, ...jsxElement(element) })
      } else if (ts.isObjectLiteralExpression(node)) {
        const routePath = property(node, 'path'), element = property(node, 'element')
        if (routePath && ts.isStringLiteral(routePath) && element) routes.push({ path: routePath.text, ...jsxElement(element) })
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return routes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function lazyPageImports(root, app) {
  const imports = []
  for (const relative of ['src/App.tsx', 'src/p2/mount.tsx', 'src/p3/mount.tsx', 'src/p4/mount.tsx']) {
    const ast = source(path.join(root, 'apps', app, relative))
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
        imports.push({ file: relative, module: node.arguments[0].text })
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return imports
}
export function routeSourceDigest(root, app) {
  return createHash('sha256').update(['src/App.tsx', 'src/p2/mount.tsx', 'src/p3/mount.tsx', 'src/p4/mount.tsx']
    .map((file) => file + '\t' + createHash('sha256').update(readFileSync(path.join(root, 'apps', app, file))).digest('hex') + '\n').join('')).digest('hex')
}
