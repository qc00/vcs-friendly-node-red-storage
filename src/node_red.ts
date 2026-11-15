import * as Path from "path";
import type { Log } from "@node-red/util";
import type { NodeWithOffload } from "./offload_naming";

// Fish out the node-red runtime instead of installing it as a dependency
export const nodeRedModules = function fishPath() {
  const needle = "lib/red.js";
  const fn = require.main.children.find(child => child.filename.endsWith(needle)).filename;
  return fn.substring(0, fn.length - needle.length) + "node_modules";
}();
export const log: Log = require(Path.join(nodeRedModules, "@node-red/util")).log;
export const projects = require(Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/projects"));
export const util: UtilModule = require(Path.join(nodeRedModules, "@node-red/runtime/lib/storage/localfilesystem/util.js"));
if (!log || !util) {
  throw new Error("Failed to extract modules from node-red runtime");
}

export interface UtilModule {
  parseJSON(text: string): any;
  writeFile(path: string, content: string | NodeWithOffload[], backupPath: string): Promise<void>;
  readFile(path: string, backupPath: string, emptyResponse: any, type: string): Promise<any>;
}

// @node-red/runtime/lib/storage/localfilesystem/projects/Project.js
export interface Project {
  stageFile(files: any): Promise<void>;
  getFlowFile(): string | null;
}
