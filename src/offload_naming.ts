import type { NodeDef } from "node-red";

export interface NodeWithOffload extends NodeDef {
  _vcsOffload?: string[];
  label?: string;
  x?: number;
  y?: number;
}

export const rules: {[nodeType: string]: {[prop: string]: string}} = {
  "typescript-config": { "tsconfig": "json" },
  "typescript": { "func": "ts", "initialize": "ts", "finalize": "ts", "code": "ts", "declare": "d.ts" },
  "function": {"func": "js", "initialize": "js", "finalize": "js"},
  "ui_template": { "format": "htm" },
};

export type SafeName = string & { _safeName: never };
export type SafeNames = { [id: string]: SafeName };

export function toSafeName(name: string | undefined, type: string): SafeName {
  const safe = (name || "").substring(0, 80)
    .replace(/[<>:"/\\|?*~\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[. ]+|[. ]+$/g, "")
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, "$1_$2");
  return (safe || type) as SafeName;
}

export function dedup(names: SafeNames): SafeNames {
  const out: SafeNames = Object.create(null);
  const firstIds: { [lowerCaseName: string]: string } = Object.create(null);
  const withId = (id: string) => `${names[id]}-${id}` as SafeName;

  for (const [id, name] of Object.entries(names)) {
    const firstId = (firstIds[name.toLowerCase()] ??= id);
    if (firstId === id) {
      out[id] = name;
    } else {
      out[firstId] = withId(firstId);
      out[id] = withId(id);
    }
  }
  return out;
}

export function tabNames(nodes: NodeWithOffload[]): SafeNames {
  const tabs: SafeNames = Object.create(null);
  for (const node of nodes) {
    if (node.type === "tab" || node.type === "subflow") {
      tabs[node.id] = toSafeName(node.label || node.name, node.type);
    }
  }
  return dedup(tabs);
}

export function offloadNames(nodes: NodeWithOffload[]): SafeNames {
  const tabs = tabNames(nodes);

  const names: SafeNames = Object.create(null);
  for (const node of nodes) {
    if (rules[node.type]) {
      names[node.id] = `${tabs[node.z] ?? "."}/${toSafeName(node.name, node.type)}` as SafeName;
    }
  }
  return dedup(names);
}
