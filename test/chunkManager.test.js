import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import ChunkManager from '../src/world/chunks/ChunkManager.js'

const config = {
  seed: 1,
  terrain: {
    width: 128,
    depth: 128,
    cellSize: 0.2,
    layerHeight: 0.095,
    maxHeight: 36,
    waterLevel: 3,
    noiseScale: 34,
    noiseOctaves: 4,
    noiseGain: 0.5,
    noiseLacunarity: 2,
    ao: { enabled: false, previewGrayscale: false }
  },
  placement: { enablePrefabs: true, enableTrees: false },
  water: { enableWater: false },
  chunks: {
    size: 32,
    halo: 1,
    windowRadius: 1,
    maxPendingBuildsPerFrame: 1,
    visibilityPadding: 0
  }
}

function createSlotFactory(calls = []) {
  return (index) => {
    const group = new THREE.Group()
    group.visible = false
    return {
      index,
      coord: null,
      group,
      terrainRenderer: { material: { name: `terrain-${index}` } },
      waterRenderer: null,
      prefabBuilds: 0,
      prefabsBuiltForKey: null,
      prefabsVisible: false,
      isLoadedFor(coord) {
        return this.coord !== null && this.coord.x === coord.x && this.coord.z === coord.z
      },
      populate({ coord }) {
        this.coord = { ...coord }
        calls.push({ slot: index, coord: { ...coord } })
      },
      show() {
        this.group.visible = true
      },
      hide() {
        this.group.visible = false
      },
      setOverlaysVisible(visible) {
        this.overlaysVisible = visible
      },
      ensurePrefabsBuilt() {
        const key = `${this.coord.x}:${this.coord.z}`
        if (this.prefabsBuiltForKey === key) {
          return
        }
        this.prefabBuilds++
        this.prefabsBuiltForKey = key
      },
      setPrefabsVisible(visible) {
        this.prefabsVisible = visible
      },
      updateInstanceColors() {
        this.instanceColorsUpdated = true
      },
      dispose() {
        this.disposed = true
      }
    }
  }
}

function createManager({ calls = [], overrides = {} } = {}) {
  return new ChunkManager({
    config: {
      ...config,
      placement: { ...config.placement },
      chunks: { ...config.chunks, ...overrides }
    },
    terrainGenerator: {
      generateChunk({ origin, size, halo }) {
        return { origin, visibleSize: size, halo }
      }
    },
    layeredTerrainBuilder: {
      buildPlacements() {
        return []
      }
    },
    brickColorResolver: {},
    brickGeometry: new THREE.BoxGeometry(0.2, 0.095, 0.2),
    parentGroup: new THREE.Group(),
    createSlot: createSlotFactory(calls)
  })
}

function assertManagerInvariants(manager) {
  const activeSlots = new Set(manager.activeSlots.values())
  const freeSlots = new Set(manager.freeSlots)

  assert.equal(activeSlots.size, manager.activeSlots.size)
  assert.equal(freeSlots.size, manager.freeSlots.length)

  for (const slot of activeSlots) {
    assert.equal(freeSlots.has(slot), false)
  }

  assert.deepEqual(
    new Set(manager.pendingQueue.map((coord) => `${coord.x}:${coord.z}`)),
    manager.pendingKeys
  )
  assert.deepEqual(new Set(manager.pendingPrefabBuildQueue), manager.pendingPrefabBuildKeys)
  assert.equal(manager.pendingPrefabBuildQueue.length, manager.pendingPrefabBuildKeys.size)
}

function updateUntilTerrainLoaded(manager, worldX, worldZ) {
  while (manager.pendingQueue.length > 0) {
    manager.update(worldX, worldZ)
  }
}

function updateUntilPrefabQueueDrained(manager, worldX, worldZ) {
  while (manager.pendingPrefabBuildQueue.length > 0) {
    manager.update(worldX, worldZ)
  }
}

function settleChunkAndPrefabQueues(manager, worldX, worldZ) {
  updateUntilTerrainLoaded(manager, worldX, worldZ)
  updateUntilPrefabQueueDrained(manager, worldX, worldZ)
}

test('bootstrap creates fixed slot pool, loads center, and queues outer window', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)

  assert.equal(manager.slots.length, 9)
  assert.equal(manager.activeSlots.size, 1)
  assert.equal(manager.pendingQueue.length, 8)
  assert.deepEqual(calls.map((call) => call.coord), [{ x: 1, z: 1 }])
  assert.equal(manager.freeSlots.length, 8)
})

test('update builds at most one pending outer chunk per frame', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  manager.update(6.4, 6.4)

  assert.equal(calls.length, 2)
  assert.equal(manager.activeSlots.size, 2)
  assert.equal(manager.pendingQueue.length, 7)
})

test('bootstrap resets previously loaded and pending chunk state', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  manager.update(6.4, 6.4)
  manager.bootstrap(19.2, 19.2)

  assert.equal(manager.activeSlots.size, 1)
  assert.equal(manager.pendingQueue.length, 8)
  assert.equal(manager.freeSlots.length, 8)
  assert.deepEqual(calls.at(-1).coord, { x: 3, z: 3 })
})

test('loadCoordNow throws when the fixed slot pool is exhausted', () => {
  const manager = createManager({ overrides: { windowRadius: 0 } })

  manager.bootstrap(0, 0)

  assert.throws(
    () => manager.loadCoordNow({ x: 1, z: 0 }),
    /No free slot available for chunk 1:0/
  )
})

test('loadCoordNow removes directly loaded coords from pending state', () => {
  const manager = createManager()

  manager.bootstrap(6.4, 6.4)
  assert.equal(manager.pendingKeys.has('0:0'), true)

  manager.loadCoordNow({ x: 0, z: 0 })

  assert.equal(manager.pendingKeys.has('0:0'), false)
  assert.equal(manager.pendingQueue.some((coord) => coord.x === 0 && coord.z === 0), false)
  assert.equal(manager.pendingQueue.length, 7)
  assertManagerInvariants(manager)
})

test('moving one chunk reuses overlap and queues newly exposed coords', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  while (manager.pendingQueue.length > 0) {
    manager.update(6.4, 6.4)
  }
  assert.equal(manager.activeSlots.size, 9)

  manager.update(12.8, 6.4)

  assert.equal(manager.activeSlots.size, 7)
  assert.equal(manager.freeSlots.length, 2)
  assert.equal(manager.pendingQueue.length, 2)
  assert.ok(manager.activeSlots.has('2:1'))
  assertManagerInvariants(manager)
})

test('diagonal movement keeps 2x2 overlap, builds center, and queues remaining exposed coords', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  while (manager.pendingQueue.length > 0) {
    manager.update(6.4, 6.4)
  }

  manager.update(12.8, 12.8)

  assert.equal(manager.activeSlots.size, 5)
  assert.equal(manager.freeSlots.length, 4)
  assert.equal(manager.pendingQueue.length, 4)
  assert.ok(manager.activeSlots.has('2:2'))
  assertManagerInvariants(manager)
})

test('a diagonal window change retains four prefab populations and builds five new ones', () => {
  const calls = []
  const manager = createManager({ calls })
  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)
  const previousSlots = new Map(manager.activeSlots)
  const previousPrefabBuilds = manager.slots.reduce((sum, slot) => sum + slot.prefabBuilds, 0)

  manager.update(12.8, 12.8)
  const retainedKeys = [...manager.activeSlots.keys()].filter((key) => previousSlots.has(key))
  assert.equal(retainedKeys.length, 4)
  for (const key of retainedKeys) {
    assert.equal(manager.activeSlots.get(key), previousSlots.get(key))
    assert.equal(manager.activeSlots.get(key).prefabsVisible, true)
  }
  settleChunkAndPrefabQueues(manager, 12.8, 12.8)

  assert.equal(calls.length, 14)
  assert.equal(manager.slots.reduce((sum, slot) => sum + slot.prefabBuilds, 0), previousPrefabBuilds + 5)
  assert.ok([...manager.activeSlots.values()].every((slot) => slot.prefabsVisible))
  assertManagerInvariants(manager)
})

test('new center chunk is built synchronously when it was not already loaded', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  manager.update(32, 6.4)

  assert.ok(manager.activeSlots.has('5:1'))
  assert.deepEqual(calls[1].coord, { x: 5, z: 1 })
  assertManagerInvariants(manager)
})

test('an immediate center load consumes the terrain frame budget after a teleport', () => {
  const calls = []
  const manager = createManager({ calls })
  manager.bootstrap(6.4, 6.4)
  const buildsBeforeMove = calls.length

  manager.update(32, 32)

  assert.equal(calls.length - buildsBeforeMove, 1)
  assert.equal(manager.activeSlots.size, 1)
  assert.equal(manager.pendingQueue.length, 8)
  assert.equal(manager.pendingPrefabBuildQueue.length, 0)
  assert.equal(manager.activeSlots.get('5:5').prefabsVisible, true)
  assertManagerInvariants(manager)
})

test('pending terrain prioritizes the nearest chunk bounds before travel direction', () => {
  const calls = []
  const manager = createManager({ calls })
  manager.bootstrap(6.4, 9.6)

  // The player moves right, but the left neighbor is much nearer to the circle.
  manager.update(6.5, 9.6)

  assert.deepEqual(calls.at(-1).coord, { x: 0, z: 1 })
})

test('movement direction breaks equal-distance terrain build ties', () => {
  const calls = []
  const manager = createManager({ calls })
  manager.bootstrap(9.5, 9.6)
  manager.update(9.6, 9.6)

  assert.deepEqual(calls.at(-1).coord, { x: 2, z: 1 })
})

test('pending prefab builds use the current position and movement priority', () => {
  const manager = createManager({ overrides: { maxPendingBuildsPerFrame: 8 } })
  manager.bootstrap(9.5, 9.6)
  manager.maxPrefabBuildsPerFrame = 0
  manager.update(9.5, 9.6)
  assert.equal(manager.pendingPrefabBuildQueue.length, 8)

  manager.maxPrefabBuildsPerFrame = 1
  manager.update(9.6, 9.6)

  assert.equal(manager.activeSlots.get('2:1').prefabsVisible, true)
  assert.equal(manager.activeSlots.get('0:1').prefabsVisible, false)
  assert.equal(manager.pendingPrefabBuildQueue.length, 7)
  assertManagerInvariants(manager)
})

test('teleporting cancels old queued prefabs while the new window finishes', () => {
  const manager = createManager({ overrides: { maxPendingBuildsPerFrame: 8 } })
  manager.bootstrap(6.4, 6.4)
  manager.update(6.4, 6.4)
  const oldQueuedKeys = new Set(manager.pendingPrefabBuildQueue)
  assert.ok(oldQueuedKeys.size > 0)

  manager.update(64, 64)
  assert.ok(manager.pendingPrefabBuildQueue.every((key) => !oldQueuedKeys.has(key)))
  assertManagerInvariants(manager)
  settleChunkAndPrefabQueues(manager, 64, 64)

  assert.equal(manager.activeSlots.size, 9)
  assert.ok([...manager.activeSlots.values()].every((slot) => slot.prefabsVisible))
  assertManagerInvariants(manager)
})

test('stale pending coords are removed after a large move', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  assert.equal(manager.pendingKeys.has('0:1'), true)

  manager.update(32, 32)

  assert.equal(manager.pendingKeys.has('0:1'), false)
  assert.ok([...manager.pendingKeys].every((key) => key.startsWith('4:') || key.startsWith('5:') || key.startsWith('6:')))
  assertManagerInvariants(manager)
})

test('loaded required slots stay visible without camera culling', () => {
  const calls = []
  const manager = createManager({ calls })
  const camera = {
    isOrthographicCamera: true,
    left: -2,
    right: 2,
    top: 2,
    bottom: -2,
    zoom: 1,
    position: { x: 6.4, z: 6.4 }
  }

  manager.bootstrap(6.4, 6.4, camera)
  while (manager.pendingQueue.length > 0) {
    manager.update(6.4, 6.4, camera)
  }

  const loadedCount = manager.activeSlots.size
  const visibleCount = [...manager.activeSlots.values()].filter((slot) => slot.group.visible).length

  assert.equal(loadedCount, 9)
  assert.equal(visibleCount, loadedCount)
  assert.equal(manager.freeSlots.length, 0)
})

test('every loaded terrain slot builds and shows prefabs', () => {
  const manager = createManager()

  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)

  const prefabActiveSlots = [...manager.activeSlots.entries()]
    .filter(([, slot]) => slot.prefabsVisible)
    .map(([key]) => key)
    .sort()
  assert.deepEqual(prefabActiveSlots, [...manager.activeSlots.keys()].sort())
  assert.equal(prefabActiveSlots.length, 9)
  assert.ok([...manager.activeSlots.values()].every((slot) => slot.prefabBuilds === 1))
})

test('crossing local chunk midlines retains all built prefab groups', () => {
  const manager = createManager()

  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)
  const slotsBeforeMove = new Map(manager.activeSlots)
  manager.update(9.6, 9.6)

  assert.equal(manager.pendingPrefabBuildQueue.length, 0)
  for (const [key, slot] of manager.activeSlots) {
    assert.equal(slot, slotsBeforeMove.get(key))
    assert.equal(slot.prefabsVisible, true)
    assert.equal(slot.prefabBuilds, 1)
  }
})

test('all active loaded slots build prefabs once per chunk key', () => {
  const manager = createManager()

  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)

  const visibleSlots = [...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible)
  manager.update(6.4, 6.4)
  manager.update(6.4, 6.4)

  assert.equal(visibleSlots.length, 9)
  assert.ok(visibleSlots.every((slot) => slot.prefabBuilds === 1))
})

test('terrain and prefab builds both progress without exceeding their frame limits', () => {
  const calls = []
  const manager = createManager({ calls, overrides: { maxPendingBuildsPerFrame: 3 } })

  manager.bootstrap(6.4, 6.4)
  const buildCountAfterBootstrap = [...manager.activeSlots.values()]
    .reduce((sum, slot) => sum + slot.prefabBuilds, 0)

  manager.update(6.4, 6.4)

  const prefabBuildsAfterTerrainFrame = manager.slots
    .reduce((sum, slot) => sum + slot.prefabBuilds, 0)
  assert.equal(calls.length, 4)
  assert.equal(manager.pendingQueue.length, 5)
  assert.equal(prefabBuildsAfterTerrainFrame, buildCountAfterBootstrap + 1)
  assert.equal(manager.pendingPrefabBuildQueue.length, 2)
  assertManagerInvariants(manager)
  manager.update(6.4, 6.4)
  const prefabBuildsAfterNextFrame = manager.slots
    .reduce((sum, slot) => sum + slot.prefabBuilds, 0)

  assert.equal(calls.length, 7)
  assert.equal(prefabBuildsAfterNextFrame, buildCountAfterBootstrap + 2)
  assertManagerInvariants(manager)
})

test('a custom prefab frame limit drains only that many queued populations', () => {
  const manager = createManager({
    overrides: { maxPendingBuildsPerFrame: 8, maxPrefabBuildsPerFrame: 2 }
  })
  manager.bootstrap(6.4, 6.4)

  manager.update(6.4, 6.4)
  assert.equal(manager.slots.reduce((sum, slot) => sum + slot.prefabBuilds, 0), 3)
  assert.equal(manager.pendingPrefabBuildQueue.length, 6)
  manager.update(6.4, 6.4)
  assert.equal(manager.slots.reduce((sum, slot) => sum + slot.prefabBuilds, 0), 5)
  assert.equal(manager.pendingPrefabBuildQueue.length, 4)
  assertManagerInvariants(manager)
})

test('disabling prefabs hides built slots and restoring them reuses existing prefab instances', () => {
  const terrainBuilds = []
  const manager = createManager({ calls: terrainBuilds })

  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)
  const builtCount = terrainBuilds.length
  const prefabBuilds = manager.slots.reduce((total, slot) => total + slot.prefabBuilds, 0)
  assert.equal([...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible).length, 9)

  manager.setPrefabsEnabled(false)
  assert.ok(manager.slots.every((slot) => !slot.prefabsVisible))
  manager.update(6.4, 6.4)
  assert.ok(manager.slots.every((slot) => !slot.prefabsVisible))
  assert.equal(terrainBuilds.length, builtCount)
  assert.equal(manager.slots.reduce((total, slot) => total + slot.prefabBuilds, 0), prefabBuilds)

  manager.setPrefabsEnabled(true)
  manager.update(6.4, 6.4)
  assert.equal([...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible).length, 9)
  assert.equal(terrainBuilds.length, builtCount)
  assert.equal(manager.slots.reduce((total, slot) => total + slot.prefabBuilds, 0), prefabBuilds)
})

test('disabling prefabs clears queued builds until they are enabled again', () => {
  const manager = createManager({ overrides: { maxPendingBuildsPerFrame: 3 } })

  manager.bootstrap(6.4, 6.4)
  manager.update(6.4, 6.4)
  assert.ok(manager.pendingPrefabBuildQueue.length > 0)
  const prefabBuilds = manager.slots.reduce((total, slot) => total + slot.prefabBuilds, 0)

  manager.setPrefabsEnabled(false)
  assert.equal(manager.pendingPrefabBuildQueue.length, 0)
  assert.equal(manager.pendingPrefabBuildKeys.size, 0)
  updateUntilTerrainLoaded(manager, 6.4, 6.4)
  manager.update(6.4, 6.4)
  assert.ok(manager.slots.every((slot) => !slot.prefabsVisible))
  assert.equal(manager.slots.reduce((total, slot) => total + slot.prefabBuilds, 0), prefabBuilds)

  manager.setPrefabsEnabled(true)
  manager.update(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)
  assert.equal([...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible).length, 9)
})

test('tree-only placement remains active when regular prefabs are hidden', () => {
  const manager = createManager()
  manager.config.placement.enableTrees = true

  manager.bootstrap(6.4, 6.4)
  settleChunkAndPrefabQueues(manager, 6.4, 6.4)
  manager.setPrefabsEnabled(false)
  manager.update(6.4, 6.4)
  assert.equal([...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible).length, 9)

  manager.config.placement.enableTrees = false
  manager.syncPlacementVisibility()
  manager.update(6.4, 6.4)
  assert.ok(manager.slots.every((slot) => !slot.prefabsVisible))

  manager.config.placement.enableTrees = true
  manager.syncPlacementVisibility()
  manager.update(6.4, 6.4)
  assert.equal([...manager.activeSlots.values()].filter((slot) => slot.prefabsVisible).length, 9)
})

test('ao preview updates all slots and only shows overlays on visible slots', () => {
  const calls = []
  const manager = createManager({ calls })

  manager.bootstrap(6.4, 6.4)
  manager.refreshAOPreview(false)

  assert.ok(manager.slots.every((slot) => slot.instanceColorsUpdated))
  assert.ok(manager.slots.every((slot) => slot.overlaysVisible === false))
})
