/**
 * Phase 1 demo: verifies the backprojection math visually, with no tile pipeline yet.
 *
 * Draws a 15° graticule and the world boundary twice — once in true geographic coordinates
 * (what Mercator shows) and once backprojected into map space (what Equal Earth shows).
 * Toggling between them makes the warp directly observable, and the readout lets you check
 * any individual coordinate.
 */

import { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../style.css';

import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';
import { MERCATOR_MAX_LATITUDE, type LngLatTuple } from '../src/index.js';

type Mode = 'geographic' | 'equal-earth';

/** Densify a segment so a straight line in one space stays curved in the other. */
const STEPS = 90;

function graticuleFeatures(warp: (p: LngLatTuple) => LngLatTuple): GeoJSON.FeatureCollection {
  const lines: GeoJSON.Feature[] = [];
  const line = (coordinates: LngLatTuple[], role: string): GeoJSON.Feature => ({
    type: 'Feature',
    properties: { role },
    geometry: { type: 'LineString', coordinates: coordinates.map(warp) },
  });

  // Meridians every 15°, sampled densely enough to render as smooth curves.
  for (let lng = -180; lng <= 180; lng += 15) {
    const pts: LngLatTuple[] = [];
    for (let i = 0; i <= STEPS; i++) {
      pts.push([lng, -90 + (180 * i) / STEPS]);
    }
    lines.push(line(pts, lng === 0 ? 'prime' : 'meridian'));
  }

  // Parallels every 15°.
  for (let lat = -90; lat <= 90; lat += 15) {
    const pts: LngLatTuple[] = [];
    for (let i = 0; i <= STEPS; i++) {
      pts.push([-180 + (360 * i) / STEPS, lat]);
    }
    lines.push(line(pts, lat === 0 ? 'equator' : 'parallel'));
  }

  return { type: 'FeatureCollection', features: lines };
}

const identity = (p: LngLatTuple): LngLatTuple => p;

const map = new MapLibreMap({
  container: 'map',
  center: [0, 0],
  zoom: 1,
  renderWorldCopies: false,
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1622' } }],
  },
});

let mode: Mode = 'equal-earth';

function currentData(): GeoJSON.FeatureCollection {
  return graticuleFeatures(mode === 'equal-earth' ? geographicToMap : identity);
}

map.on('load', () => {
  map.addSource('graticule', { type: 'geojson', data: currentData() });

  map.addLayer({
    id: 'graticule-lines',
    type: 'line',
    source: 'graticule',
    paint: {
      'line-color': [
        'match',
        ['get', 'role'],
        'equator',
        '#ffb347',
        'prime',
        '#ffb347',
        '#3d7ea6',
      ],
      'line-width': ['match', ['get', 'role'], 'equator', 2, 'prime', 2, 1],
    },
  });
});

/* ---------------------------------------------------------------- controls */

const modeButton = document.querySelector<HTMLButtonElement>('#mode')!;
const readout = document.querySelector<HTMLPreElement>('#readout')!;

function refresh(): void {
  const source = map.getSource('graticule');
  if (source && 'setData' in source) {
    (source as { setData: (d: GeoJSON.FeatureCollection) => void }).setData(currentData());
  }
  modeButton.textContent = mode === 'equal-earth' ? 'Showing: Equal Earth' : 'Showing: Geographic';
}

modeButton.addEventListener('click', () => {
  mode = mode === 'equal-earth' ? 'geographic' : 'equal-earth';
  refresh();
});

const format = (p: LngLatTuple): string => `${p[0].toFixed(4).padStart(10)}, ${p[1].toFixed(4).padStart(9)}`;

map.on('mousemove', (event) => {
  const mapSpace: LngLatTuple = [event.lngLat.lng, event.lngLat.lat];
  if (Math.abs(mapSpace[1]) > MERCATOR_MAX_LATITUDE) return;

  const geographic = mode === 'equal-earth' ? mapToGeographic(mapSpace) : mapSpace;
  const roundTrip = geographicToMap(geographic);

  readout.textContent = [
    `map space   ${format(mapSpace)}`,
    `geographic  ${format(geographic)}`,
    `round trip  ${format(roundTrip)}`,
  ].join('\n');
});

// Convenience for poking at the math from the browser console.
Object.assign(window, { map, geographicToMap, mapToGeographic });
