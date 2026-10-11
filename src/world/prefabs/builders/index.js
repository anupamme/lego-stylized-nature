import { buildCactus } from './cactus.js'
import { buildDuckweed } from './duckweed.js'
import { buildFlower } from './flower.js'
import { buildGrassShort, buildGrassTall } from './grass.js'
import { buildMushroom } from './mushroom.js'
import { buildPhragmites } from './phragmites.js'
import { buildVolcanoRock, buildVolcanoRockSmall } from './volcanoRock.js'

export const prefabBuilders = {
  cactus: buildCactus,
  duckweed: buildDuckweed,
  flower: buildFlower,
  grassShort: buildGrassShort,
  grassTall: buildGrassTall,
  mushroom: buildMushroom,
  phragmites: buildPhragmites,
  volcanoRock: buildVolcanoRock,
  volcanoRockSmall: buildVolcanoRockSmall
}
