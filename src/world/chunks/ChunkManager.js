import HeightfieldAO from '../bricks/HeightfieldAO.js'
import LavaBrickRenderer from '../bricks/LavaBrickRenderer.js'
import TerrainBrickRenderer from '../bricks/TerrainBrickRenderer.js'
import WaterBrickRenderer from '../bricks/WaterBrickRenderer.js'
import PrefabPlacer from '../prefabs/PrefabPlacer.js'
import {
  getChunkBounds,
  getChunkWindowCoords,
  getRenderChunkCoord,
  getRenderChunkKey,
  getRenderChunkOrigin,
  getWorldBlockFromPosition,
} from './chunkCoordinates.js'
import ChunkRenderSlot from './ChunkRenderSlot.js'

export default class ChunkManager {
  constructor({
    config,
    terrainGenerator,
    layeredTerrainBuilder,
    brickColorResolver,
    brickGeometry,
    materials,
    parentGroup,
    biomeRegistry = null,
    prefabRegistry = null,
    createSlot = null,
  }) {
    this.config = config
    this.terrainGenerator = terrainGenerator
    this.layeredTerrainBuilder = layeredTerrainBuilder
    this.brickColorResolver = brickColorResolver
    this.brickGeometry = brickGeometry
    this.materials = materials
    this.parentGroup = parentGroup
    this.biomeRegistry = biomeRegistry
    this.prefabRegistry = prefabRegistry
    this.createSlotOverride = createSlot

    const chunkConfig = config.chunks ?? {}
    this.chunkSize = chunkConfig.size ?? 64
    this.halo = chunkConfig.halo ?? 1
    this.windowRadius = chunkConfig.windowRadius ?? 1
    this.maxPendingBuildsPerFrame = chunkConfig.maxPendingBuildsPerFrame ?? 1
    this.maxPrefabBuildsPerFrame = chunkConfig.maxPrefabBuildsPerFrame ?? 1
    this.visibilityPadding = chunkConfig.visibilityPadding ?? 0
    this.debugSpacing = chunkConfig.debugSpacing ?? 0
    this.cellSize = config.terrain.cellSize
    this.buildTimings = { generationMs: 0, placementMs: 0, populateMs: 0, totalMs: 0, maxMs: 0, builds: 0 }

    const slotCount = (this.windowRadius * 2 + 1) ** 2
    this.slots = Array.from({ length: slotCount }, (_, index) => this.createSlot(index))
    this.freeSlots = [...this.slots]
    this.activeSlots = new Map()
    this.pendingQueue = []
    this.pendingKeys = new Set()
    this.pendingPrefabBuildQueue = []
    this.pendingPrefabBuildKeys = new Set()
    this.centerCoord = null
    this.schedulingPosition = null
    this.movementDirection = { x: 0, z: 0 }
    this.bootstrapped = false

    for (const slot of this.slots) {
      slot.hide()
      this.parentGroup.add(slot.group)
    }
  }

  resetLoadedState() {
    for (const slot of this.slots) {
      slot.hide()
      slot.setPrefabsVisible?.(false)
    }

    this.activeSlots.clear()
    this.pendingQueue.length = 0
    this.pendingKeys.clear()
    this.pendingPrefabBuildQueue.length = 0
    this.pendingPrefabBuildKeys.clear()
    this.freeSlots = [...this.slots]
    this.centerCoord = null
    this.schedulingPosition = null
    this.movementDirection = { x: 0, z: 0 }
    this.bootstrapped = false
  }

  createSlot(index) {
    if (this.createSlotOverride) {
      return this.createSlotOverride(index)
    }

    const prefabPlacer = this.prefabRegistry && this.biomeRegistry
      ? new PrefabPlacer({
          config: this.config,
          biomeRegistry: this.biomeRegistry,
          prefabRegistry: this.prefabRegistry,
          materials: this.materials,
        })
      : null

    const waterEnabled = this.config.water?.enableWater !== false
    return new ChunkRenderSlot({
      index,
      chunkSize: this.chunkSize,
      cellSize: this.cellSize,
      terrainRenderer: new TerrainBrickRenderer({
        config: this.config,
        brickGeometry: this.brickGeometry,
        materials: this.materials,
      }),
      heightfieldAO: new HeightfieldAO({ config: this.config }),
      prefabPlacer,
      waterRenderer: waterEnabled
        ? new WaterBrickRenderer({
            config: this.config,
            brickGeometry: this.brickGeometry,
            materials: this.materials,
          })
        : null,
      lavaRenderer: new LavaBrickRenderer({
        config: this.config,
        brickGeometry: this.brickGeometry,
        materials: this.materials,
      }),
    })
  }

  bootstrap(worldX, worldZ, camera = null) {
    this.resetLoadedState()

    const worldBlock = this.getStableWorldBlockFromPosition(worldX, worldZ)
    const centerCoord = getRenderChunkCoord(worldBlock.x, worldBlock.z, this.chunkSize)

    this.updateSchedulingPosition(worldX, worldZ)
    this.centerCoord = centerCoord
    this.bootstrapped = true
    this.loadCoordNow(centerCoord)
    this.queuePendingCoords(getChunkWindowCoords(centerCoord, this.windowRadius))
    this.updateVisibility(worldBlock)
  }

  getStableWorldBlockFromPosition(worldX, worldZ) {
    const worldBlock = getWorldBlockFromPosition(worldX, worldZ, this.cellSize)

    return {
      x: this.snapNearIntegerBlock(worldX, worldBlock.x),
      z: this.snapNearIntegerBlock(worldZ, worldBlock.z),
    }
  }

  snapNearIntegerBlock(worldPosition, fallbackBlock) {
    const scaled = worldPosition / this.cellSize
    const rounded = Math.round(scaled)

    return Math.abs(scaled - rounded) < 1e-9 ? rounded : fallbackBlock
  }

  update(worldX, worldZ, camera = null) {
    if (!this.bootstrapped) {
      this.bootstrap(worldX, worldZ, camera)
      return
    }

    const worldBlock = this.getStableWorldBlockFromPosition(worldX, worldZ)
    const nextCenterCoord = getRenderChunkCoord(worldBlock.x, worldBlock.z, this.chunkSize)
    this.updateSchedulingPosition(worldX, worldZ)

    let immediateBuilds = 0
    if (!this.coordsEqual(this.centerCoord, nextCenterCoord)) {
      immediateBuilds = this.reconcileRequiredWindow(nextCenterCoord)
    }

    this.buildPendingChunks(Math.max(0, this.maxPendingBuildsPerFrame - immediateBuilds))
    this.updateVisibility(worldBlock)
  }

  updateSchedulingPosition(worldX, worldZ) {
    const previous = this.schedulingPosition
    const dx = previous ? worldX - previous.x : 0
    const dz = previous ? worldZ - previous.z : 0
    const distance = Math.hypot(dx, dz)
    this.movementDirection.x = distance > 0 ? dx / distance : 0
    this.movementDirection.z = distance > 0 ? dz / distance : 0
    this.schedulingPosition = { x: worldX, z: worldZ }
  }

  getBuildPriority(coord) {
    const position = this.schedulingPosition ?? { x: 0, z: 0 }
    const bounds = getChunkBounds(coord, this.chunkSize, this.cellSize)
    const spacingX = coord.x * this.debugSpacing
    const spacingZ = coord.z * this.debugSpacing
    const dx = Math.max(bounds.minX + spacingX - position.x, 0, position.x - bounds.maxX - spacingX)
    const dz = Math.max(bounds.minZ + spacingZ - position.z, 0, position.z - bounds.maxZ - spacingZ)
    const centerX = (bounds.minX + bounds.maxX) * 0.5 + spacingX - position.x
    const centerZ = (bounds.minZ + bounds.maxZ) * 0.5 + spacingZ - position.z

    return {
      distanceSquared: dx * dx + dz * dz,
      ahead: centerX * this.movementDirection.x + centerZ * this.movementDirection.z,
    }
  }

  compareBuildCoords(a, b) {
    const aPriority = this.getBuildPriority(a)
    const bPriority = this.getBuildPriority(b)
    const distanceDifference = aPriority.distanceSquared - bPriority.distanceSquared
    if (Math.abs(distanceDifference) > 1e-9) {
      return distanceDifference
    }
    const directionDifference = bPriority.ahead - aPriority.ahead
    if (Math.abs(directionDifference) > 1e-9) {
      return directionDifference
    }
    return a.x - b.x || a.z - b.z
  }

  coordsEqual(a, b) {
    return a !== null && b !== null && a.x === b.x && a.z === b.z
  }

  reconcileRequiredWindow(nextCenterCoord) {
    this.centerCoord = { ...nextCenterCoord }

    const requiredCoords = getChunkWindowCoords(nextCenterCoord, this.windowRadius)
    const requiredKeys = new Set(requiredCoords.map(coord => getRenderChunkKey(coord)))

    for (const [key, slot] of this.activeSlots) {
      if (requiredKeys.has(key)) {
        continue
      }

      slot.hide()
      slot.setPrefabsVisible?.(false)
      this.removePendingPrefabBuild(key)
      this.activeSlots.delete(key)
      this.freeSlots.push(slot)
    }

    this.pendingQueue = this.pendingQueue.filter((coord) => {
      const key = getRenderChunkKey(coord)
      return requiredKeys.has(key) && !this.activeSlots.has(key)
    })
    this.pendingKeys = new Set(this.pendingQueue.map(coord => getRenderChunkKey(coord)))

    const centerKey = getRenderChunkKey(nextCenterCoord)
    let immediateBuilds = 0
    if (!this.activeSlots.has(centerKey)) {
      this.loadCoordNow(nextCenterCoord)
      immediateBuilds = 1
    }

    this.queuePendingCoords(requiredCoords)
    return immediateBuilds
  }

  queuePendingCoords(coords) {
    for (const coord of coords) {
      const key = getRenderChunkKey(coord)
      if (this.activeSlots.has(key) || this.pendingKeys.has(key)) {
        continue
      }

      this.pendingQueue.push({ ...coord })
      this.pendingKeys.add(key)
    }
  }

  removePendingCoord(coord) {
    const key = getRenderChunkKey(coord)
    if (!this.pendingKeys.has(key)) {
      return
    }

    this.pendingQueue = this.pendingQueue.filter(pendingCoord => getRenderChunkKey(pendingCoord) !== key)
    this.pendingKeys.delete(key)
  }

  removePendingPrefabBuild(key) {
    if (!this.pendingPrefabBuildKeys.has(key)) {
      return
    }

    this.pendingPrefabBuildQueue = this.pendingPrefabBuildQueue.filter(pendingKey => pendingKey !== key)
    this.pendingPrefabBuildKeys.delete(key)
  }

  buildPendingChunks(limit = this.maxPendingBuildsPerFrame) {
    this.pendingQueue.sort((a, b) => this.compareBuildCoords(a, b))
    let built = 0

    while (built < limit && this.pendingQueue.length > 0) {
      const coord = this.pendingQueue.shift()
      this.pendingKeys.delete(getRenderChunkKey(coord))
      if (this.loadCoordNow(coord)) {
        built++
      }
    }

    return built
  }

  buildPendingPrefabs(desiredPrefabKeys) {
    this.pendingPrefabBuildQueue = this.pendingPrefabBuildQueue.filter((key) => {
      const keep = desiredPrefabKeys.has(key) && this.activeSlots.has(key)
      if (!keep) {
        this.pendingPrefabBuildKeys.delete(key)
      }
      return keep
    })
    this.pendingPrefabBuildQueue.sort((a, b) => this.compareBuildCoords(
      this.activeSlots.get(a).coord,
      this.activeSlots.get(b).coord,
    ))

    let built = 0
    while (built < this.maxPrefabBuildsPerFrame && this.pendingPrefabBuildQueue.length > 0) {
      const key = this.pendingPrefabBuildQueue.shift()
      this.pendingPrefabBuildKeys.delete(key)

      if (!desiredPrefabKeys.has(key)) {
        continue
      }

      const slot = this.activeSlots.get(key)
      if (!slot) {
        continue
      }

      slot.ensurePrefabsBuilt?.()
      slot.setPrefabsVisible?.(true)
      built++
    }
  }

  loadCoordNow(coord) {
    this.removePendingCoord(coord)

    const key = getRenderChunkKey(coord)
    const activeSlot = this.activeSlots.get(key)
    if (activeSlot) {
      return activeSlot
    }

    const slot = this.freeSlots.shift()
    if (!slot) {
      throw new Error(`[ChunkManager] No free slot available for chunk ${key}`)
    }

    this.fillSlot(slot, coord)
    this.activeSlots.set(key, slot)
    return slot
  }

  fillSlot(slot, coord) {
    const started = performance.now()
    const origin = getRenderChunkOrigin(coord, this.chunkSize)
    const terrainMap = this.terrainGenerator.generateChunk({
      origin,
      size: this.chunkSize,
      halo: this.halo,
    })
    const generated = performance.now()
    const placements = this.layeredTerrainBuilder.buildPlacements(terrainMap)
    const placed = performance.now()

    slot.populate({
      coord,
      terrainMap,
      placements,
      colorResolver: this.brickColorResolver,
      debugSpacing: this.debugSpacing,
    })
    const finished = performance.now()
    Object.assign(this.buildTimings, {
      generationMs: generated - started,
      placementMs: placed - generated,
      populateMs: finished - placed,
      ...slot.buildTimings,
      totalMs: finished - started,
      maxMs: Math.max(this.buildTimings.maxMs, finished - started),
      builds: this.buildTimings.builds + 1,
    })
  }

  setDebugSpacing(spacing) {
    this.debugSpacing = spacing
    this.config.chunks.debugSpacing = spacing

    for (const slot of this.slots) {
      slot.updateWorldPosition(spacing)
    }
  }

  setPrefabsEnabled(enabled) {
    this.config.placement.enablePrefabs = enabled
    this.syncPlacementVisibility()
  }

  syncPlacementVisibility() {
    const placementEnabled = this.config.placement?.enablePrefabs !== false
      || this.config.placement?.enableTrees !== false
    for (const slot of this.slots) {
      slot.prefabPlacer?.syncVariantGroupVisibility()
      if (!placementEnabled) {
        slot.setPrefabsVisible?.(false)
      }
    }
    if (!placementEnabled) {
      this.pendingPrefabBuildQueue.length = 0
      this.pendingPrefabBuildKeys.clear()
    }
  }

  updateVisibility(worldBlock, { buildPrefabs = true } = {}) {
    const placementEnabled = this.config.placement?.enablePrefabs !== false
      || this.config.placement?.enableTrees !== false
    const prefabActiveKeys = new Set(this.activeSlots.keys())

    for (const [key, slot] of this.activeSlots) {
      slot.show()

      if (!placementEnabled) {
        slot.setPrefabsVisible?.(false)
        continue
      }

      if (slot.prefabsBuiltForKey === key) {
        slot.setPrefabsVisible?.(true)
      }
      else if (!this.pendingPrefabBuildKeys.has(key)) {
        slot.setPrefabsVisible?.(false)
        this.pendingPrefabBuildQueue.push(key)
        this.pendingPrefabBuildKeys.add(key)
      }
    }

    if (placementEnabled && buildPrefabs) {
      this.buildPendingPrefabs(prefabActiveKeys)
    }
  }

  refreshAOPreview(showOverlays = true) {
    for (const slot of this.slots) {
      slot.updateInstanceColors()
      slot.setOverlaysVisible(showOverlays && slot.group.visible)
    }
  }

  getDebugMaterials() {
    return {
      legoMaterial: this.materials?.legoMaterial ?? null,
      waterMaterial: this.materials?.waterMaterial ?? null,
    }
  }

  dispose() {
    for (const slot of this.slots) {
      slot.dispose()
      slot.group.parent?.remove(slot.group)
    }

    this.slots.length = 0
    this.freeSlots.length = 0
    this.activeSlots.clear()
    this.pendingQueue.length = 0
    this.pendingKeys.clear()
    this.pendingPrefabBuildQueue.length = 0
    this.pendingPrefabBuildKeys.clear()
  }
}
