/**
 * Equal Earth projection support for MapLibre GL JS.
 *
 * MapLibre cannot blend a projection of its own with Mercator, so the adaptive `equal` (and pure
 * Equal Earth before MapLibre 6.15) is produced by feeding the Mercator renderer coordinates that
 * have been pre-warped ("backprojected") such that Mercator's own transform reproduces the Equal
 * Earth image. See `src/math/backproject.ts` for the details and the lineage of the technique.
 * On MapLibre 6.15+, pure `equal-earth` is native: the plugin registers Equal Earth with MapLibre's
 * experimental `addProjection`, whose tile grid is the warped tiles' own (`src/math/crs.ts`).
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
  EQUAL_EARTH_CRS_NAME,
  EQUAL_EARTH_DEFINITION,
  equalEarthConverter,
  equalEarthCrs,
  equalEarthProjectionHandler,
  type CrsConverter,
  type CrsDefinition,
} from './math/crs.js';

export {
  GRID_FACTOR,
  MAP_SPACE_MAX_LATITUDE,
  MERCATOR_MAX_LATITUDE,
  WEB_MERCATOR_MAX,
  WEB_MERCATOR_RADIUS,
  geographicToMap,
  mapSpaceMaxLatitude,
  mapSpaceMaxLongitude,
  mapToGeographic,
  worldYRange,
} from './math/backproject.js';

export {
  relativeJacobian,
  similarity,
  similarityOffsets,
  type CompensationMode,
  type Matrix2,
  type SimilarityOffsets,
} from './math/jacobian.js';

export {
  BandCamera,
  ThresholdCamera,
  type BandCameraOptions,
  type BandSelector,
  type CameraHost,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
  type Compensation,
  type GestureEndEvent,
  type LngLatFactory,
  type ThresholdCameraOptions,
} from './map/camera.js';

export {
  EQUAL_EARTH_BANDS,
  bandIndexForZoom,
  bandIndexWithHysteresis,
  bandSourceId,
  continuousBlend,
  originalLayerId,
  parseRange,
  resolveTransition,
  validateBands,
  type Band,
  type ResolvedTransition,
  type Transition,
} from './map/bands.js';

export {
  graticule,
  worldOutline,
  worldPolygon,
  type CartographyOptions,
  type CartographySpace,
  type GraticuleOptions,
  type OutlineOptions,
} from './map/cartography.js';

export {
  createEqualEarthConstrain,
  installEqualEarthConstrain,
  type ConstrainHost,
  type DefaultConstrainOwner,
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

export { clipFeatureToTile, type TileFeature } from './tiles/clip.js';

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
  CACHE_NAME_PREFIX,
  PersistentTileCache,
  hashSourceConfig,
  persistentKey,
  type CacheLike,
  type CacheStorageLike,
  type PersistentCacheOptions,
} from './tiles/persistent-cache.js';

export {
  EntryCache,
  RequestCoalescer,
  TileCache,
  type TileCacheOptions,
} from './tiles/cache.js';

export {
  REWRITTEN_METADATA_KEY,
  applyGate,
  rewriteStyle,
  type GateHost,
  type GatePhase,
  type LayerGate,
  type RewriteOptions,
  type RewrittenStyle,
  type SourceTemplate,
  type StyleLayerLike,
  type StyleLike,
} from './map/style-rewrite.js';

export { GEOJSON_MAX_DENSIFY_ZOOM, geojsonZoomForBand, warpGeoJSON, type WarpGeoJSONOptions } from './map/geojson.js';

export { geographicUnder, mapSpaceOf } from './map/geo-api.js';

export {
  EqualEarthController,
  SUPERSEDED_ERROR_NAME,
  type ControllerBaseOptions,
  type ControllerHost,
  type ControllerOptions,
  type EqualEarthProjection,
  type HostStyle,
  type LngLatBoundsFactory,
} from './map/controller.js';

export {
  installEqualEarth,
  parseVersion,
  type EqualEarthInstall,
  type InstallOptions,
  type MapLibreModule,
} from './install.js';

export {
  BandSwitcher,
  chooseBand,
  type SwitchEvent,
  type SwitcherHost,
  type SwitcherOptions,
} from './map/switcher.js';

export {
  EqualEarthControl,
  type ControlHost,
  type EqualEarthControlOptions,
} from './map/control.js';
