# Prefab Radial Reveal Design

## Problem

`ChunkManager` loads terrain for a 3x3 chunk window, but shows prefabs only in the 2x2 chunks nearest the player (`getPlayerPrefabWindowCoords`). The 2x2 set is chosen by the player's quadrant inside the center chunk, so crossing a chunk midline hides three whole chunks of prefabs and rebuilds three others. When the camera is zoomed out this boundary is on screen and the swap reads as a whole chunk vanishing and reappearing elsewhere.

## Goal

- Prefabs never appear or disappear a whole chunk at a time.
- Distant prefabs shrink smoothly to nothing instead of popping.
- No new per-frame CPU work proportional to instance count.

## Design

### 1. Prefabs follow the 3x3 terrain window

Remove the 2x2 prefab window. `ChunkManager.updateVisibility()` treats every active slot as a prefab slot. Prefab builds stay cached per slot and stay rate-limited by `maxPrefabBuildsPerFrame`, so crossing a chunk still builds at most three new prefab sets, spread across frames.

`getPlayerPrefabWindowCoords` and its tests are deleted.

### 2. Radial scale in the vertex shader

Each prefab instance gets a scale factor:

```
s = 1 - smoothstep(innerRadius, outerRadius, distanceXZ(pivotWorld, revealCenter))
position = pivot + (position - pivot) * s
```

- `pivot` is the instance's placement point (the transform position written by `PrefabPlacer`), so every instance scales rigidly about its own base. All current prefab meshes have zero node translation, so this equals the instance matrix translation.
- `revealCenter` is a shared `vec3` uniform set each frame from the player aircraft position in `World.update()`.
- The shadow pass reuses `material.positionNode`, so shadows shrink with the mesh.

### 3. Radius limits

With a 3x3 window the player is always at least one chunk width (`chunks.size * terrain.cellSize` = 14.4 world units) from the unloaded area. `outerRadius` must not exceed that, so every visible prefab lies inside a loaded chunk and chunk boundaries never show through prefabs. The shadow follow extent in `World.update()` uses the same 14.4 half-extent.

New config:

```js
placement: {
  reveal: {
    innerRadius: 10,
    outerRadius: 13.5
  }
}
```

At default zoom the ring is far off screen; at maximum zoom-out (`minZoom` 0.5) prefabs shrink near the screen edges.

### 4. Per-instance pivot data

Three r185 builds the instance matrix node inside `instancedMesh()` and does not expose it to materials, and `positionNode` runs after instancing. So each prefab `InstancedMesh` carries its own `InstancedBufferAttribute` (`vec3`, one per instance, sized to bucket capacity) in `mesh.userData`. `PrefabPlacer.populateInstancedMesh()` writes `t.position` into it alongside the instance matrix.

The reveal `positionNode` is a TSL `Fn` that reads the attribute from `builder.object` through `instancedBufferAttribute()` and transforms it to world space with `modelWorldMatrix`. This is safe to share across meshes because r185 render-object cache keys include `object.uuid` for instanced meshes, so node builder state is per mesh.

Risk: this relies on the `Fn` body running once per node build with the current `builder.object`. The first implementation step verifies this. Fallback: read the translation column from the mesh's own `instanceMatrix` array through an `InstancedInterleavedBuffer`, which needs no extra CPU writes but duplicates the matrix upload.

### 5. One material entry point

Prefab materials come from GLB sources (classic `MeshStandardMaterial`), procedural builders (`createLegoMaterial`, already a node material), biome tint clones, instance-color clones, and tree materials (classic `MeshPhysicalMaterial`).

- `WorldMaterials` owns the reveal uniforms and a `resolveRevealMaterial(material)` cache that returns a node material with the reveal `positionNode`, keyed by source material. Classic materials are converted to the matching node material class once.
- `PrefabPlacer.resolveMeshContext()` passes its final material through this resolver.
- Tree materials are created as `MeshPhysicalNodeMaterial` directly.
- `WorldMaterials.dispose()` disposes the reveal materials it created.

### 6. Pipeline warmup

`PrefabPipelineWarmup` meshes use the same resolved reveal materials and carry the same pivot attribute, so warmup compiles exactly the shaders used at runtime. Without this, the first frame that shows each prefab would compile a new pipeline.

## Cost

- Prefab draw calls and visible instances rise by about 2.25x (9 chunks instead of 4). GPU buffers already exist for all 9 slots.
- Vertex shader adds one distance and one smoothstep per vertex.
- Instances outside the ring still submit vertices but produce no fragments.
- Pivot attribute: 12 bytes per instance of bucket capacity.

## Testing

- Unit: `ChunkManager` shows and queues prefabs for all active slots; pivot attribute is written for each placed instance; warmup meshes carry the pivot attribute; `resolveRevealMaterial` caches per source material and returns node materials.
- Manual: fly across chunk midlines and boundaries at minimum zoom; confirm no whole-chunk swaps, smooth shrink at the ring, shadows shrinking with meshes, and no first-appearance stutter. Compare frame time and draw calls in the `#debug` Performance panel before and after.

## Out of scope

- Terrain loading at the 3x3 window edge. If it is visible at maximum zoom-out, raise `chunks.windowRadius` separately.
- Per-instance radius jitter.
