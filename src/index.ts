/**
 * Equal Earth projection support for MapLibre GL JS.
 *
 * MapLibre has no API for registering a custom projection, so Equal Earth is produced by
 * feeding the Mercator renderer coordinates that have been pre-warped ("backprojected")
 * such that Mercator's own transform reproduces the Equal Earth image. See
 * `src/math/backproject.ts` for the details and the lineage of the technique.
 *
 * @packageDocumentation
 */

export {
  EARTH_RADIUS,
  EQUAL_EARTH_X_MAX,
  EQUAL_EARTH_Y_MAX,
  fromEqualEarth,
  toEqualEarth,
  type LngLatTuple,
  type PointTuple,
} from './math/equal-earth.js';

export {
  GRID_FACTOR,
  MAP_SPACE_MAX_LATITUDE,
  MERCATOR_MAX_LATITUDE,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_RADIUS,
  geographicToMap,
  mapToGeographic,
} from './math/backproject.js';

export {
  ThresholdCamera,
  type CameraHost,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
  type LngLatFactory,
  type ThresholdCameraOptions,
} from './map/camera.js';

export {
  createEqualEarthConstrain,
  installEqualEarthConstrain,
  type ConstrainHost,
  type EqualEarthConstrainOptions,
  type LngLatLike,
  type TransformConstrainFn,
} from './map/constrain.js';

export {
  TILE_EXTENT,
  densify,
  densifyAndWarp,
  toleranceForZoom,
  warpOnly,
  type SubdivideOptions,
} from './math/subdivide.js';

export {
  preimageBBox,
  sourceTilesFor,
  tileWorldBounds,
  tilesForBBox,
  type BBox,
  type TileCoverOptions,
  type TileId,
} from './tiles/tile-cover.js';

export {
  buildTile,
  decodeToGeographic,
  mergeLayers,
  warpFeature,
  warpTiles,
  type GeographicLayers,
  type WarpTileOptions,
} from './tiles/mvt.js';

export {
  PROTOCOL_SCHEME,
  createEqualEarthProtocol,
  encodeSourceUrl,
  expandTemplate,
  parseTileUrl,
  type EqualEarthSourceConfig,
  type ParsedTileUrl,
  type ProtocolHandler,
  type ProtocolOptions,
} from './tiles/protocol.js';

export {
  RequestCoalescer,
  TileCache,
  type TileCacheOptions,
} from './tiles/cache.js';
