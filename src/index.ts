/* Parts that are offloaded (stored outside the flow file):
A: Use configurable properties
B: Node coordinates

Additional handling:
C: Adds offloaded files to git auto-commit
D: Delete offloaded files for nodes that are deleted
E: One line per node if possible
F: Offloaded files are stored as <flow dir>/<tab label>/<node name>.<prop>.<ext> instead of <node id>.<prop>.<ext>
   (id suffix only on name collisions). The legacy layout is still readable and is converted on the next deploy.
*/

import * as Path from "path";
import * as fs from "fs/promises";
import type { Node } from "node-red";
import type { Log } from "@node-red/util";

// Fish out the node-red runtime instead of installing it as a dependency
const nodeRedModules = function fishPath() {
  const needle = "lib/red.js";
  const fn = require.main.children.find(child => child.filename.endsWith(needle)).filename;
  return fn.substring(0, fn.length - needle.length) + "node_modules";
}();
const log: Log = require(Path.join(nodeRedModules, "@node-red/util")).log;
const projects = require(Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/projects"));
const util: UtilModule = require(Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/util.js"));
if (!log || !util) {
  throw new Error("Failed to extract modules from node-red runtime");
}

//
const flowSuffix = Path.sep + "flows.json";
const COORD_FILE = "coord.json";

interface NodeWithOffload extends Node {
  _vcsOffload?: string[];
  x?: number;
  y?: number;
}

interface UtilModule {
  parseJSON(text: string): any;
  writeFile(path: string, content: string | NodeWithOffload[], backupPath: string): Promise<void>;
  readFile(path: string, backupPath: string, emptyResponse: any, type: string): Promise<any>;
}

// @node-red/runtime/lib/storage/localfilesystem/projects/Project.js
interface Project {
  stageFile(files: any): Promise<void>;
  getFlowFile(): string | null;
}

function getOriginal<T extends Function>(fn: T): T {
  return (fn as any)?._vcsFriendlyOriginal || fn;
}

// #region Patch projects.saveFlows to implement feature C
const saveSerializing: { [path: string]: Promise<unknown> } = {};
let addToGit: string[] = [];

const origSaveFlows = getOriginal(projects?.saveFlows);
if (origSaveFlows) {
  projects.saveFlows = function vcsFriendlySaveFlows(flows: any) {
    const original = () => origSaveFlows.apply(this, arguments);
    const active: Project = projects.getActiveProject();
    const flowFile = active?.getFlowFile();
    if (!flowFile) return original();

    async function body() {
      // Patch auto-commit files
      const origStageFile = active.stageFile;
      if (origStageFile) {
        addToGit.length = 0;
        active.stageFile = function (files: any) {
          if (Array.isArray(files) && files.includes(flowFile)) {
            files.push(...addToGit);
          }
          return origStageFile.apply(this, arguments);
        };
      }

      try {
        return await withPatchedStringify(flows, original);
      } finally {
        active.stageFile = origStageFile;
        addToGit.length = 0;
      }
    }

    // Simple serializing to protect addToGit
    const prev = saveSerializing[flowFile];
    const out = prev ? prev.then(body) : body();
    saveSerializing[flowFile] = out.then(_=>1, _=>0);
    return out;
  };
  (projects.saveFlows as any)._vcsFriendlyOriginal = origSaveFlows;

  // Patch JSON.stringify to avoid having to immediately deserialize
  function withPatchedStringify(flows: any, callback: () => any) {
    const origStringify = JSON.stringify;
    JSON.stringify = function replacementStringify(obj: any) {
      return Object.is(obj, flows) ? structuredClone(obj) : origStringify.apply(this, arguments);
    };

    try {
      // At the time of writing, the origSaveFlows does not use await meaning stringify is called synchronously. Thus,
      // we restore stringify synchronously to avoid an unpredictable chain of origStringify.
      return callback();
    } finally {
      JSON.stringify = origStringify;
    }
  }
}
// #endregion

// #region util.writeFile
const rules: {[nodeType: string]: {[prop: string]: string}} = {
  "function": {"func": "js", "initialize": "js"},
  "ui_template": {"format": "htm"},
};

const offloadPathsByFlow: { [flowPath: string]: Set<string> } = {};
const EMPTY_SET: ReadonlySet<string> = new Set();

function shouldOffload(node: NodeWithOffload, prop: string, val: any) {
  if (!val) return false;
  if (typeof val !== 'string') {
    log.warn(`${prop} in ${node.type} is not a string`);
    return false;
  }
  if (!val.includes("\n") && val.length < 200) return false;
  return true;
}

// Naming (feature F)
const GLOBAL_FOLDER = "_global";
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 80;

function sanitize(name: unknown, fallback: string): string {
  function clean(str: string) {
    return str
      .replace(/[<>:"/\\|?*~\x00-\x1f\x7f]/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[. ]+|[. ]+$/g, "");
  }
  let s = clean(typeof name === "string" ? name : "");
  if (s.length > MAX_NAME_LENGTH) s = clean(s.substring(0, MAX_NAME_LENGTH));
  if (!s) s = clean(fallback) || "_";
  return RESERVED_NAME.test(s) ? "_" + s : s;
}

// Case-insensitive collisions: every member of a colliding group gets the id suffix
function dedupe(items: { id: string, base: string }[]): Map<string, string> {
  const groups = new Map<string, { id: string, base: string }[]>();
  for (const item of items) {
    const key = item.base.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    for (const { id, base } of group) {
      out.set(id, group.length === 1 ? base : `${base}~${sanitize(id, "id")}`);
    }
  }
  return out;
}

// z (tab/subflow id) -> folder name
function buildFolders(nodes: NodeWithOffload[]): Map<string, string> {
  const globalId = "\0" + GLOBAL_FOLDER; // Cannot clash with a node id
  const items = [{ id: globalId, base: GLOBAL_FOLDER }];
  for (const node of nodes) {
    if (node.type === "tab") {
      items.push({ id: node.id, base: sanitize((node as any).label, node.type) });
    } else if (node.type === "subflow") {
      items.push({ id: node.id, base: sanitize(node.name, node.type) });
    }
  }
  const folders = dedupe(items);
  folders.set(globalId, GLOBAL_FOLDER); // Reserved: a tab labelled "_global" is the one that gets suffixed
  return folders;
}

function folderOf(folders: Map<string, string>, node: NodeWithOffload): string {
  return folders.get(node.z) ?? GLOBAL_FOLDER;
}

// node id -> file base name, unique per folder across all nodes with offload rules
function buildFileBases(nodes: NodeWithOffload[], folders: Map<string, string>): Map<string, string> {
  const byFolder = new Map<string, { id: string, base: string }[]>();
  for (const node of nodes) {
    if (!rules[node.type]) continue;
    const folder = folderOf(folders, node);
    const list = byFolder.get(folder);
    const item = { id: node.id, base: sanitize(node.name, node.type) };
    if (list) list.push(item); else byFolder.set(folder, [item]);
  }
  const out = new Map<string, string>();
  for (const list of byFolder.values()) {
    for (const [id, base] of dedupe(list)) out.set(id, base);
  }
  return out;
}

const originalWriteFile = getOriginal(util.writeFile);

util.writeFile = async (path, content, backupPath) => {
  if (path.endsWith(flowSuffix)) {
    log.info(`Processing flow file [${path}]`);
    const dir = Path.dirname(path);
    const coord = [];
    const oldPaths = offloadPathsByFlow[path] || EMPTY_SET; // Feature D
    const newPaths = offloadPathsByFlow[path] = new Set<string>();
    const output: string[] = [];
    const writes: { p: string, val: string }[] = [];

    if (typeof content === 'string') {
      content = util.parseJSON(content);
    }

    const nodes = content as NodeWithOffload[];
    const folders = buildFolders(nodes); // Feature F
    const bases = buildFileBases(nodes, folders);

    for (const node of nodes) {
      // A:
      delete node._vcsOffload;

      const rule = rules[node.type];
      if (rule) {
        log.debug(`Processing ${node.type} node [${node.id}]`);
        const folder = folderOf(folders, node);
        for (const [prop, ext] of Object.entries(rule)) {
          const val = node[prop];
          if (shouldOffload(node, prop, val)) {
            const file = `${bases.get(node.id)}.${prop}.${ext}`;
            const p = Path.join(dir, folder, file);
            writes.push({ p, val });
            addToGit.push(p);
            newPaths.add(p);
            (node._vcsOffload || (node._vcsOffload = [])).push(`${folder}/${file}`);
            delete node[prop];
          }
        }
      }

      // B:
      if (node.hasOwnProperty("x") && node.hasOwnProperty("y")) {
        coord.push(node.id, node.x, node.y);
        delete node.x;
        delete node.y;
      }

      // E:
      let json = JSON.stringify(node, null, 2);
      if (json.length < 200) json = json.replace(/\n\s*/g, "");
      output.push(json);
    }

    // D: Delete stale files (including the legacy <id>.<prop>.<ext> ones) first, then the folders they emptied, and
    // only then create folders and write. This order matters on case-insensitive file systems (tab foo -> Foo).
    const stale = [...oldPaths].filter(p => !newPaths.has(p));
    await Promise.all(stale.map(p => fs.unlink(p)
      .then(() => { addToGit.push(p); })
      .catch(_ => void 0)));
    const staleDirs = new Set(stale.map(p => Path.dirname(p)));
    staleDirs.delete(dir); // Never the flow directory itself
    await Promise.all([...staleDirs].map(d => fs.rmdir(d).catch(_ => void 0)));

    const targetDirs = new Set(writes.map(w => Path.dirname(w.p)));
    await Promise.all([...targetDirs].map(d => fs.mkdir(d, { recursive: true })));
    await Promise.all([
      ...writes.map(w => fs.writeFile(w.p, w.val)),
      fs.writeFile(Path.join(dir, COORD_FILE), JSON.stringify(coord)), // Not added to git
    ]);
    content = `[${output.join(",\n")}]`;
  }
  return originalWriteFile(path, content, backupPath);
};

(util.writeFile as any)._vcsFriendlyOriginal = originalWriteFile;
// #endregion

// #region util.readFile
// Resolves a _vcsOffload entry: "<folder>/<file>" (feature F) or the legacy "<prop>.<ext>" (file named <id>.<entry>)
function resolveOffload(dir: string, node: NodeWithOffload, entry: string): { path: string, prop: string } {
  const invalid = () => new Error(`Invalid offload path [${entry}] in node ${node.id}`);
  if (typeof entry !== "string") throw invalid();

  let path: string;
  let basename: string;
  if (entry.includes("/")) {
    const segments = entry.split("/");
    if (entry.includes("\\") || Path.isAbsolute(entry) || segments.some(s => s === "" || s === "." || s === "..")) {
      throw invalid();
    }
    path = Path.join(dir, ...segments);
    basename = segments[segments.length - 1];
  } else {
    if (entry.includes("..")) throw invalid();
    path = Path.join(dir, `${node.id}.${entry}`);
    basename = entry;
  }

  const parts = basename.split(".");
  const prop = parts[parts.length - 2];
  if (!prop) throw invalid();
  return { path, prop };
}

const originalReadFile = getOriginal(util.readFile);

util.readFile = async (path, backupPath, emptyResponse, type) => {
  const data = await originalReadFile(path, backupPath, emptyResponse, type);
  if (Object.is(data, emptyResponse) || !path.endsWith(flowSuffix)) {
    return data;
  }

  const dir = Path.dirname(path);
  const coordPromise = fs.readFile(Path.join(dir, COORD_FILE), 'utf8').then(util.parseJSON);

  const allPromises: Promise<any>[] = [];
  const lookup: {[id: string]: NodeWithOffload} = {}; // Feature B
  const paths = offloadPathsByFlow[path] = new Set(); // Feature D

  // A:
  for (const node of data as NodeWithOffload[]) {
    if (node.id in lookup) {
      throw new Error(`Duplicate node id [${node.id}] in flow file [${path}]`);
    }
    lookup[node.id] = node;

    if (node._vcsOffload) {
      for (const offload of node._vcsOffload) {
        const { path, prop } = resolveOffload(dir, node, offload);
        allPromises.push(fs.readFile(path, 'utf8').then(data => node[prop] = data));
        paths.add(path);
      };

      if (allPromises.length >= 10) {
        await Promise.all(allPromises);
        allPromises.length = 0;
      }
    }
  }

  // B:
  try {
    const coord = await coordPromise;
    for (let i = 0; i < coord.length; i += 3) {
      const id = coord[i];
      const node = lookup[id];
      if (node) {
        node.x = coord[i + 1];
        node.y = coord[i + 2];
      }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      log.warn(`Error reading coordinates from ${COORD_FILE}: ${e}`);
    }
  }

  await Promise.all(allPromises);
  return data;
};

(util.readFile as any)._vcsFriendlyOriginal = originalReadFile;
// #endregion
