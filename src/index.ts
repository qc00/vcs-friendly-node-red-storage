/* Parts that are offloaded (stored outside the flow file):
A: Use configurable properties
B: Node coordinates

Additional handling:
C: Adds offloaded files to git auto-commit
D: Delete offloaded files for nodes that are deleted
E: One line per node if possible
F: Name offloaded files as <tab name>/<node name>
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
  label?: string;
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

type SafeName = string & { _safeName: never };
type SafeNames = { [id: string]: SafeName };

function toSafeName(name: string | undefined, type: string): SafeName {
  const safe = (name || "").substring(0, 80)
    .replace(/[<>:"/\\|?*~\x00-\x1f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[. ]+|[. ]+$/g, "")
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, "$1_$2");
  return (safe || type) as SafeName;
}

function dedup(names: SafeNames): SafeNames {
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

function offloadNames(nodes: NodeWithOffload[]): SafeNames {
  let tabs: SafeNames = Object.create(null);
  for (const node of nodes) {
    if (node.type === "tab" || node.type === "subflow") {
      tabs[node.id] = toSafeName(node.label || node.name, node.type);
    }
  }
  tabs = dedup(tabs);

  const names: SafeNames = Object.create(null);
  for (const node of nodes) {
    if (rules[node.type]) {
      names[node.id] = `${tabs[node.z] ?? "."}/${toSafeName(node.name, node.type)}` as SafeName;
    }
  }
  return dedup(names);
}

const originalWriteFile = getOriginal(util.writeFile);

util.writeFile = async (path, content, backupPath) => {
  if (path.endsWith(flowSuffix)) {
    log.info(`Processing flow file [${path}]`);
    const dir = Path.dirname(path);
    const writes: [path: string, val: string][] = [];
    const coord = [];
    const oldPaths = offloadPathsByFlow[path] || EMPTY_SET; // Feature D
    const newPaths = offloadPathsByFlow[path] = new Set<string>();
    const output: string[] = [];

    const nodes: NodeWithOffload[] = typeof content === 'string' ? util.parseJSON(content) : content;
    const names = offloadNames(nodes); // Feature F

    for (const node of nodes) {
      // A:
      delete node._vcsOffload;

      const rule = rules[node.type];
      if (rule) {
        log.debug(`Processing ${node.type} node [${node.id}]`);
        for (const [prop, ext] of Object.entries(rule)) {
          const val = node[prop];
          if (shouldOffload(node, prop, val)) {
            const offload = `${names[node.id]}.${prop}.${ext}`;
            const p = Path.join(dir, offload);
            writes.push([p, val]);
            addToGit.push(p);
            newPaths.add(p);
            (node._vcsOffload || (node._vcsOffload = [])).push(offload);
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

    // D: Finish deleting before writing, as a renamed file may be the same file on a case-insensitive file system
    const stale = [...oldPaths].filter(p => !newPaths.has(p));
    await Promise.all(stale.map(p => fs.unlink(p).then(() => addToGit.push(p), _ => void 0)));

    await Promise.all([
      ...writes.map(([p, val]) => fs.mkdir(Path.dirname(p), { recursive: true }).then(() => fs.writeFile(p, val))),
      fs.writeFile(Path.join(dir, COORD_FILE), JSON.stringify(coord)), // Not added to git
    ]);
    content = `[${output.join(",\n")}]`;
  }
  return originalWriteFile(path, content, backupPath);
};

(util.writeFile as any)._vcsFriendlyOriginal = originalWriteFile;
// #endregion

// #region util.readFile
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
        if (offload.includes("..")) {
          throw new Error(`Invalid offload path [${offload}] in node ${node.id}`);
        }
        const [prop] = offload.split(".").slice(-2);
        const isNamedAfterId = !offload.includes("/");
        const path = Path.join(dir, isNamedAfterId ? `${node.id}.${offload}` : offload);
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
