# pTS-Effect

Node-graph editor for authoring 2D sprite shader effects in Cocos Creator 3.8.8.
Connect nodes in a graph panel, save, and it compiles to a **standard `.effect`**
asset — zero runtime overhead, zero script dependency.

## Install

1. Keep the `pts-effect` folder under `extensions/`.
2. Restart Cocos Creator (the bootstrap auto-installs/builds on first load).

## Usage

- **Open**: menu `Extension → pTS-Effect → Open Effect Editor`.
- **Create**: right-click in the Assets panel → `Create Effect`, or use the empty-state
  button inside the panel.
- **Edit**: drag nodes from the left library onto the canvas; connect an output port to
  an input port; edit parameters in the right inspector.
- **Save**: `Ctrl+S` or the Save button. The graph is embedded in the effect's first-line
  comment, so re-opening the `.effect` restores the node graph.
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
