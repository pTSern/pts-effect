# pTS-Effect

Node-graph editor for authoring 2D sprite shader effects in Cocos Creator 3.8.8.
Connect nodes in a graph panel, save, and it compiles to a **standard `.effect`**
asset — zero runtime overhead, zero script dependency.

## Install

1. Keep the `pts-effect` folder under `extensions/`.
2. Restart Cocos Creator (the bootstrap auto-installs/builds on first load).

## Usage

- **Open**: menu `Extension → pTS-Effect → Open Effect Editor`.
- **Open by drag**: drag an `.effect` from the Assets panel onto pTS-Effect. Switching away from an edited graph asks before discarding changes.
- **Create**: right-click in the Assets panel → `Create Effect`, or use the empty-state
  button inside the panel.
- **Edit**: drag nodes from the left library onto the canvas; connect an output port to
  an input port; edit parameters in the right inspector.
- **Save**: `Ctrl+S` or the Save button. The graph is embedded in the effect's first-line
  comment, so re-opening the `.effect` restores the node graph.
- **Existing effects**: hand-written effects without a valid embedded pTS-Effect graph cannot be reconstructed or overwritten by this editor. Create a separate graph effect instead.
- **Save As New**: save the current graph to a separate effect without overwriting the original.
- **Blackboard**: create named float, vector, color, or texture properties; add property nodes from the Blackboard and wire them to the graph. Texture defaults are built-in white or grey; assign project textures on a material.
- **Reusable subgraphs**: use **New Subgraph**, add typed inputs and outputs in its interface, place input nodes and connect the output nodes, then save the `.ptsgraph.json` asset. Add a **Subgraph** node to an effect or another subgraph and select the saved asset in its inspector. Use its signature refresh control after changing the saved interface; incompatible connections are removed. Missing assets, mismatched signatures and recursive dependencies prevent compilation.
- **Custom functions**: add a **Custom Function** node, define typed input and output ports in its inspector, and write a GLSL function body using the port names as identifiers. Assign every output in the body; the editor supplies the function signature.
- **Dependency updates**: saving a subgraph does not automatically regenerate effects that use it. Re-save affected effects after editing a dependency; update a node's signature first if its interface changed.
- **Compilation**: graphs require exactly one Output. Only nodes connected to it generate shader code; invalid links and cycles are reported before saving.
- **Language**: English by default; switch to 中文 via the toolbar dropdown or
  Project Settings → pTS-Effect.

## Controls

| Action | Shortcut |
|--------|----------|
| Pan | middle-drag, or Shift/Ctrl+drag |
| Zoom | mouse wheel |
| Box select | left-drag on empty canvas |
| Add to selection | Ctrl+click |
| Break wire | Alt+click an input port |
| Add node | double-click canvas, or drag from library |
| Copy / Paste selected graph nodes | Ctrl+C / Ctrl+V when the canvas is focused |
| Duplicate selected graph nodes | Ctrl+D when the canvas is focused |
| Delete selection | Delete / Backspace |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z |
| Save | Ctrl+S |
