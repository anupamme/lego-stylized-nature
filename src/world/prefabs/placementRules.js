import { pickWeighted, random01, snapValue } from '../../utils/random.js'

export function canPlacePrefab(rule, manifestEntry, biomeCell, surfaceCell) {
  const placement = manifestEntry.placement ?? {}

  if (surfaceCell.isLava) {
    return false
  }
  if (placement.surface === 'water' && !surfaceCell.isWater) {
    return false
  }
  if (placement.surface === 'land' && surfaceCell.isWater) {
    return false
  }
  if (placement.surface === 'land' && surfaceCell.isShore) {
    return false
  }
  if (placement.biomes && !placement.biomes.includes(biomeCell.biomeId)) {
    return false
  }
  if (rule.minHeight !== undefined && surfaceCell.height < rule.minHeight) {
    return false
  }
  if (rule.maxSlope !== undefined && surfaceCell.slope > rule.maxSlope) {
    return false
  }
  return true
}

export function createVariantEntries(manifestEntry, variantWeights = null) {
  return manifestEntry.variants
    .map((variant, index) => ({
      value: index,
      weight: variantWeights
        ? variantWeights[variant.source] ?? 0
        : variant.weight ?? 1,
    }))
    .filter(({ weight }) => Number.isFinite(weight) && weight > 0)
}

export function pickVariantIndex(manifestEntry, x, z, seed, entries = createVariantEntries(manifestEntry)) {
  return pickWeighted(entries, random01(x, z, seed + 131))
}

export function makePrefabTransform({
  x,
  z,
  height,
  manifestEntry,
  config,
  seed,
  worldX = x,
  worldZ = z,
}) {
  const { cellSize, layerHeight } = config.terrain
  const { rotationStep } = config.placement

  const rotationY = manifestEntry.randomRotation
    ? snapValue(random01(worldX, worldZ, seed + 17) * Math.PI * 2, rotationStep)
    : 0

  return {
    position: [(x + 0.5) * cellSize, (height + 1) * layerHeight, (z + 0.5) * cellSize],
    rotationY,
    x: worldX,
    y: height,
    z: worldZ,
  }
}
