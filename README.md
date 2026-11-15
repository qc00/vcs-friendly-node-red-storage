# @qc00/vcs-friendly-node-red-storage

Makes Node-RED's local file-system storage write flows in a version-control friendly way.

## Features

- **Code in separate files**: certain long or multi-line properties are stored as separate files organised by tabs.
- **Coordinates in a separate file**
- **One line per node**: short nodes are written on a single line of `flows.json`.
- **Suppports NodeRED projects**

## Requirements and limitations

- Developed against Node-RED 4.1. The package patches internal modules of the Node-RED runtime, so other
  versions may not work.
- Only the default local file-system storage is supported, and only when the flow file is named `flows.json`.
- Node-RED must be started through its own entry point (the `node-red` command).
  Embedding Node-RED in another application is not supported.
