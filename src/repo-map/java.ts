import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { RepoMapExport, RepoMapImport, RepoMapSymbol } from "./index.js";

const MAX_JAVA_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BRACE_NESTING = 512;
const JAVA_GRAMMAR_PATH = fileURLToPath(
  new URL("../../vendor/tree-sitter-java-orchard/tree-sitter-java_orchard.wasm", import.meta.url),
);
const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "abstract",
  "static",
  "final",
  "sealed",
  "non-sealed",
  "strictfp",
  "native",
  "synchronized",
  "transient",
  "volatile",
  "default",
]);
const TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);
const METHOD_DECLARATIONS = new Set(["method_declaration", "annotation_type_element_declaration"]);
const CONSTRUCTOR_DECLARATIONS = new Set(["constructor_declaration", "compact_constructor_declaration"]);
const FIELD_DECLARATIONS = new Set(["field_declaration", "constant_declaration"]);

export const JAVA_ANALYZER_VERSION = "web-tree-sitter@0.26.11+tree-sitter-java-orchard@0.5.10" as const;

export interface JavaAnalysis {
  packageName?: string;
  imports: RepoMapImport[];
  exports: RepoMapExport[];
  symbols: RepoMapSymbol[];
  dependencies: string[];
}

let parserPromise: Promise<Parser> | undefined;
let parserTail: Promise<void> = Promise.resolve();

function javaParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const language = await Language.load(JAVA_GRAMMAR_PATH);
    return new Parser().setLanguage(language);
  })();
  return parserPromise;
}

async function withJavaParser<T>(operation: (parser: Parser) => T): Promise<T> {
  const previous = parserTail;
  let release = (): void => undefined;
  parserTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const parser = await javaParser();
    parser.reset();
    return operation(parser);
  } finally {
    release();
  }
}

function descendants(node: Node, types: string | readonly string[]): Node[] {
  const accepted = new Set(typeof types === "string" ? [types] : types);
  const output: Node[] = [];
  const visit = (current: Node): void => {
    for (const child of current.namedChildren) {
      if (accepted.has(child.type)) output.push(child);
      visit(child);
    }
  };
  visit(node);
  return output;
}

function directChild(node: Node, type: string): Node | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

function leafTokens(node: Node, excludeAnnotations = false): Node[] {
  const output: Node[] = [];
  const visit = (current: Node): void => {
    if (
      current.isExtra ||
      current.type === "line_comment" ||
      current.type === "block_comment" ||
      (excludeAnnotations && (current.type === "annotation" || current.type === "marker_annotation"))
    ) {
      return;
    }
    if (current.childCount === 0 || current.type.endsWith("_literal")) {
      output.push(current);
      return;
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return output;
}

function render(tokens: readonly string[]): string {
  let output = "";
  let previous = "";
  for (const token of tokens) {
    if (token === ";") break;
    const noSpaceBefore = [",", ")", "]", ">", ".", "::", "..."].includes(token);
    const noSpaceAfterPrevious = ["(", "[", "<", ".", "@", "::"].includes(previous);
    const identifierGeneric = token === "<" && previous.length > 0 && !MODIFIERS.has(previous);
    const callOrParameters = token === "(";
    const separator =
      output && !noSpaceBefore && !noSpaceAfterPrevious && !identifierGeneric && !callOrParameters ? " " : "";
    output += `${separator}${token}`;
    if (token === ",") output += " ";
    previous = token;
  }
  return output.replace(/\s+/gu, " ").trim();
}

function renderedNode(node: Node): string {
  return render(leafTokens(node, true).map((token) => token.text));
}

function beforeBody(node: Node): string {
  const tokens = leafTokens(node, true).map((token) => token.text);
  const cutoff = tokens.findIndex((token) => token === "{" || token === ";");
  return render(cutoff < 0 ? tokens : tokens.slice(0, cutoff));
}

function modifiersNode(node: Node): Node | undefined {
  return directChild(node, "modifiers");
}

function annotationNames(node: Node): string[] {
  const modifiers = modifiersNode(node);
  if (!modifiers) return [];
  return descendants(modifiers, ["annotation", "marker_annotation"]).map((annotation) => {
    const name = annotation.namedChildren.find((child) => ["identifier", "scoped_identifier"].includes(child.type));
    return name?.text ?? annotation.text.replace(/^@/u, "").replace(/\(.*$/su, "");
  });
}

function modifierNames(node: Node): string[] {
  const modifiers = modifiersNode(node);
  if (!modifiers) return [];
  return leafTokens(modifiers, true)
    .map((token) => token.text)
    .filter((token) => MODIFIERS.has(token));
}

function tokenLine(node: Node, image?: string): number {
  const tokens = leafTokens(node, true);
  return (image ? tokens.find((token) => token.text === image) : tokens[0])?.startPosition.row !== undefined
    ? ((image ? tokens.find((token) => token.text === image) : tokens[0])?.startPosition.row ??
        node.startPosition.row) + 1
    : node.startPosition.row + 1;
}

function splitTopLevel(tokens: readonly string[], delimiter = ","): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (["<", "(", "["].includes(token)) depth += 1;
    if ([">", ")", "]"].includes(token)) depth -= 1;
    if (token === delimiter && depth === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts.filter((part) => part.length > 0);
}

function relationshipList(node: Node | null, keyword: string): string[] {
  if (!node) return [];
  const tokens = leafTokens(node, true).map((token) => token.text);
  const start = tokens.indexOf(keyword);
  return splitTopLevel(tokens.slice(start < 0 ? 0 : start + 1)).map(render);
}

function typeParameters(node: Node): string[] {
  const parameters = node.childForFieldName("type_parameters") ?? directChild(node, "type_parameters");
  if (!parameters) return [];
  return parameters.namedChildren
    .filter((child) => child.type === "type_parameter")
    .map((parameter) => renderedNode(parameter));
}

function declarationName(node: Node): string | undefined {
  return node.childForFieldName("name")?.text ?? directChild(node, "identifier")?.text;
}

function typeKind(node: Node): RepoMapSymbol["kind"] {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  if (node.type === "record_declaration") return "record";
  if (node.type === "annotation_type_declaration") return "annotation";
  return "class";
}

function fieldNames(node: Node): string[] {
  return descendants(node, "variable_declarator")
    .map((declarator) => declarator.childForFieldName("name")?.text ?? directChild(declarator, "identifier")?.text)
    .filter((name): name is string => Boolean(name));
}

function fieldSignature(node: Node, name: string): string {
  const tokens = leafTokens(node, true).map((token) => token.text);
  const nameIndex = tokens.indexOf(name);
  return render(tokens.slice(0, nameIndex + 1));
}

function recordComponents(node: Node, container: string, output: RepoMapSymbol[]): void {
  const parameters = node.childForFieldName("parameters") ?? directChild(node, "formal_parameters");
  if (!parameters) return;
  for (const component of parameters.namedChildren.filter((child) => child.type === "formal_parameter")) {
    const name = component.childForFieldName("name")?.text ?? directChild(component, "identifier")?.text;
    if (!name) continue;
    output.push({
      name,
      kind: "field",
      signature: renderedNode(component),
      exported: true,
      line: tokenLine(component, name),
      container,
      annotations: annotationNames(component),
      modifiers: [],
    });
  }
}

function validateBounds(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_JAVA_SOURCE_BYTES)
    throw new Error("parse error: Java source exceeds 2 MiB");
  let nesting = 0;
  let maximum = 0;
  for (const character of text) {
    if (character === "{") maximum = Math.max(maximum, ++nesting);
    else if (character === "}") nesting = Math.max(0, nesting - 1);
    if (maximum > MAX_BRACE_NESTING) throw new Error("parse error: Java brace nesting exceeds 512");
  }
}

function firstParseError(root: Node): Node | undefined {
  if (root.isError || root.isMissing) return root;
  for (const child of root.children) {
    const error = firstParseError(child);
    if (error) return error;
  }
  return undefined;
}

function analyzeTree(root: Node): JavaAnalysis {
  const imports: RepoMapImport[] = [];
  const exports: RepoMapExport[] = [];
  const symbols: RepoMapSymbol[] = [];
  const dependencies = new Set<string>();
  const packageDeclaration = root.namedChildren.find((child) => child.type === "package_declaration");
  const packageName = packageDeclaration?.namedChildren.find((child) =>
    ["identifier", "scoped_identifier"].includes(child.type),
  )?.text;

  for (const declaration of root.namedChildren.filter((child) => child.type === "import_declaration")) {
    const tokens = leafTokens(declaration).map((token) => token.text);
    const isStatic = tokens.includes("static");
    const wildcard = tokens.includes("*");
    const qualified = tokens.filter((token) => !["import", "static", ";", "*", "."].includes(token)).join(".");
    const pieces = qualified.split(".");
    imports.push({
      source: qualified,
      names: wildcard ? [] : [pieces.at(-1) as string],
      typeOnly: false,
      static: isStatic,
      wildcard,
    });
    dependencies.add(qualified);
  }

  const walk = (node: Node, container?: string, implicitlyPublic = false): void => {
    let nextContainer = container;
    let nextImplicitlyPublic = implicitlyPublic;
    if (TYPE_DECLARATIONS.has(node.type)) {
      const name = declarationName(node);
      if (name) {
        const kind = typeKind(node);
        const relationships = {
          extends:
            kind === "interface"
              ? relationshipList(directChild(node, "extends_interfaces") ?? null, "extends")
              : relationshipList(node.childForFieldName("superclass"), "extends"),
          implements: relationshipList(node.childForFieldName("interfaces"), "implements"),
          permits: relationshipList(node.childForFieldName("permits"), "permits"),
        };
        const modifiers = modifierNames(node);
        const symbol: RepoMapSymbol = {
          name,
          kind,
          signature: beforeBody(node),
          exported: modifiers.includes("public") || Boolean(container && implicitlyPublic),
          line: tokenLine(node, kind === "annotation" ? "interface" : kind),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(node),
          relationships,
        };
        symbols.push(symbol);
        if (symbol.exported) exports.push({ name, typeOnly: kind === "interface" || kind === "annotation" });
        for (const relationship of [...relationships.extends, ...relationships.implements, ...relationships.permits]) {
          dependencies.add(relationship);
          dependencies.add(relationship.replace(/<.*$/u, ""));
        }
        for (const parameter of symbol.typeParameters ?? []) {
          const bound = parameter.match(/\bextends\s+(.+)$/u)?.[1];
          if (bound) dependencies.add(bound.replace(/<.*$/u, ""));
        }
        if (kind === "record") recordComponents(node, name, symbols);
        nextContainer = name;
        nextImplicitlyPublic = kind === "interface" || kind === "annotation";
      }
    } else if (METHOD_DECLARATIONS.has(node.type)) {
      const name = declarationName(node);
      if (name) {
        const modifiers = modifierNames(node);
        const symbol: RepoMapSymbol = {
          name,
          kind: "method",
          signature: beforeBody(node),
          exported:
            modifiers.includes("public") ||
            implicitlyPublic ||
            Boolean(container && node.type === "annotation_type_element_declaration"),
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(node),
        };
        symbols.push(symbol);
        for (const parameter of symbol.typeParameters ?? []) {
          const bound = parameter.match(/\bextends\s+(.+)$/u)?.[1];
          if (bound) dependencies.add(bound.replace(/<.*$/u, ""));
        }
      }
      nextImplicitlyPublic = false;
    } else if (CONSTRUCTOR_DECLARATIONS.has(node.type)) {
      const name = declarationName(node) ?? container;
      if (name) {
        const modifiers = modifierNames(node);
        symbols.push({
          name,
          kind: "constructor",
          signature: beforeBody(node),
          exported: modifiers.includes("public"),
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(node),
        });
        nextImplicitlyPublic = false;
      }
    } else if (FIELD_DECLARATIONS.has(node.type)) {
      const modifiers = modifierNames(node);
      for (const name of fieldNames(node)) {
        symbols.push({
          name,
          kind: "field",
          signature: fieldSignature(node, name),
          exported: modifiers.includes("public") || implicitlyPublic || node.type === "constant_declaration",
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
        });
      }
      nextImplicitlyPublic = false;
    } else if (node.type === "enum_constant") {
      const name = declarationName(node);
      if (name) {
        symbols.push({
          name,
          kind: "enum-constant",
          signature: name,
          exported: true,
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers: [],
        });
      }
    }
    for (const child of node.namedChildren) walk(child, nextContainer, nextImplicitlyPublic);
  };
  walk(root);

  return {
    ...(packageName ? { packageName } : {}),
    imports,
    exports,
    symbols,
    dependencies: [...dependencies],
  };
}

export async function analyzeJava(text: string): Promise<JavaAnalysis> {
  validateBounds(text);
  return withJavaParser((parser) => {
    const tree = parser.parse(text);
    if (!tree) throw new Error("parse error: Java parser returned no syntax tree");
    try {
      if (tree.rootNode.hasError) {
        const error = firstParseError(tree.rootNode) ?? tree.rootNode;
        throw new Error(
          `parse error: Java syntax is malformed at line ${error.startPosition.row + 1}, column ${error.startPosition.column + 1}`,
        );
      }
      return analyzeTree(tree.rootNode);
    } finally {
      tree.delete();
    }
  });
}
