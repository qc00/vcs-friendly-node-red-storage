/* Parts that are offloaded (stored outside the flow file):
A: Use configurable properties
B: Node coordinates
*/

import * as Path from "path";
import * as fs from "fs/promises";
import type { Module } from "module";
import type { Node } from "node-red";
import type { Log } from "@node-red/util";

// Fish out the node-red runtime instead of installing it as a dependency
const nodeRedModules = function fishPath() {
  const needle = "lib/red.js";
  const fn = require.main.children.find(child => child.filename.endsWith(needle)).filename;
  return fn.substring(0, fn.length - needle.length) + "node_modules";
}();
const log: Log = require(Path.join(nodeRedModules, "@node-red/util")).log;
const stageFile = require(Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/projects/git")).stageFile;
if (!log || !stageFile) {
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

//
type WriteFile = (path: string, content: any, backupPath: string) => Promise<void>;
let originalWriteFile: WriteFile;

const rules: {[nodeType: string]: {[prop: string]: string}} = {
  "function": {"func": "js", "initialize": "js"},
  "ui_template": {"format": "htm"},
};

const writeFile: WriteFile = async (path, content, backupPath) => {
  if (path.endsWith(flowSuffix)) {
    const dir = Path.dirname(path);
    const allPromises: Promise<any>[] = [];
    const addToGit: string[] = [];
    const coord = [];

    for (const node of content as NodeWithOffload[]) {
      // A:
      const rule = rules[node.type];
      if (rule) {
        for (const [prop, ext] of Object.entries(rule)) {
          const p = Path.join(dir, `${node.id}.${prop}.${ext}`);
          const del = fs.unlink(p);
          allPromises.push(del);
          addToGit.push(p);

          const val = node[prop];
          if (!val) continue;
          if (typeof val !== 'string') {
            log.warn(`${prop} in ${node.type} is not a string`);
            continue;
          }
          allPromises[allPromises.length - 1] = del.then(() => fs.writeFile(p, val));
          (node._vcsOffload || (node._vcsOffload = [])).push(`${prop}.${ext}`);
        }
      }

      // B:
      if ("x" in node && "y" in node) {
        coord.push(node.id, node.x, node.y);
        delete node.x;
        delete node.y;
      }
    }

    allPromises.push(fs.writeFile(Path.join(dir, COORD_FILE), JSON.stringify(coord))); // Not added to git
    await Promise.all(allPromises);
    await stageFile(dir, addToGit);
  }
  return originalWriteFile(path, content, backupPath);
};

//
let parseJSON: (text: string) => any;

type ReadFile<R> = (path: string, backupPath: string, emptyResponse: R, type: string) => Promise<R>;
let originalReadFile: ReadFile<any>;

const readFile: ReadFile<any> = async (path, backupPath, emptyResponse, type) => {
  const data = await originalReadFile(path, backupPath, emptyResponse, type);
  if (Object.is(data, emptyResponse) || type !== 'flow') return data;
  if (!path.endsWith(flowSuffix)) {
    throw new Error(`Unsupported flow file [${path}]`);
  }
  const dir = Path.dirname(path);
  const coordPromise = fs.readFile(Path.join(dir, COORD_FILE), 'utf8').then(parseJSON);

  const allPromises: Promise<any>[] = [];
  const lookup: {[id: string]: NodeWithOffload} = {};

  // A:
  for (const node of data as NodeWithOffload[]) {
    if (node.id in lookup) {
      throw new Error(`Duplicate node id [${node.id}] in flow file [${path}]`);
    }
    lookup[node.id] = node;

    if (node._vcsOffload) {
      for (const offload of node._vcsOffload) {
        if (Path.isAbsolute(offload) || offload.includes("..")) {
          throw new Error(`Invalid offload path [${offload}] in node ${node.id}`);
        }
        const prop = offload.substring(0, offload.lastIndexOf('.'));
        const promise = fs.readFile(Path.join(dir, offload), 'utf8').then(data => node[prop] = data);
        allPromises.push(promise);
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

//
function withModuleUncached<R>(file: string, handler: (real: Module, path: string) => R): R {
  const path = Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/", file);
  const origModule = require(path);
  const fromCache = require.cache[path];
  if (!Object.is(fromCache.exports, origModule)) {
    throw new Error(`Module ${path} is not cached as expected`);
  }
  delete require.cache[path];
  try {
    return handler(fromCache, path);
  } finally {
    require.cache[path] = fromCache;
  }
}

module.exports = withModuleUncached("index.js", (_, lfsPath) => {
  withModuleUncached("util.js", (origUtilModule, path) => {
    originalReadFile = origUtilModule.exports.readFile;
    originalWriteFile = origUtilModule.exports.writeFile;
    require.cache[path] = {
      ...origUtilModule,
      exports: { ...origUtilModule.exports, readFile, writeFile },
    };
  });
  return require(lfsPath);
});
