// Kos's map style (docs/trips.md §13): OpenFreeMap's "liberty" by day, and at night the same style
// recoloured at load into a readable night palette. The night palette and rules are GRAZE's
// (rg-code/graze, assets/js/map-style.js, by the same author), kept as they are so both apps look alike.
// Layer ids are liberty's; any layer not matched keeps its colours.

export const LIBERTY_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export const NIGHT = {
  land: '#1f2530',
  residential: 'rgba(255, 255, 255, 0.035)',
  green: '#1c2a2a',
  water: '#0e1b2c',
  waterLine: '#1b3452',
  sand: '#262c35',
  building: '#29303c',
  buildingLine: '#323a47',
  aeroway: '#2a313c',
  path: '#3b4453',
  minor: '#3a4352',
  minorCasing: '#272e39',
  secondary: '#4c5667',
  secondaryCasing: '#2b323d',
  primary: '#5d687a',
  primaryCasing: '#2e3541',
  motorway: '#8792a5',
  motorwayCasing: '#3a4250',
  rail: '#3a4250',
  boundary: '#56627a',
  boundaryState: '#424d60',
  label: '#e8ebf0',
  labelSoft: '#c1c8d2',
  labelDim: '#8f99a8',
  waterLabel: '#6487b0',
  roadLabel: '#b2bbc7',
  halo: '#161b23',
};

// [layer id test, paint overrides] — the first match wins.
const RULES = [
  [/^background$/, { 'background-color': NIGHT.land }],
  // Shaded relief: kept as a faint texture.
  [/^natural_earth$/, { 'raster-brightness-max': 0.32, 'raster-saturation': -0.7 }],
  [/^park_outline$/, { 'line-color': NIGHT.green }],
  [/^(park|landcover_wood|landcover_grass|landuse_cemetery|landuse_pitch|landuse_track)$/, { 'fill-color': NIGHT.green, 'fill-outline-color': NIGHT.green }],
  [/^landuse_residential$/, { 'fill-color': NIGHT.residential }],
  [/^landcover_(ice|sand)$/, { 'fill-color': NIGHT.sand }],
  [/^landcover_wetland$/, { 'fill-opacity': 0.15 }],
  [/^landuse_(hospital|school)$/, { 'fill-color': NIGHT.sand }],
  [/^waterway/, { 'line-color': NIGHT.waterLine }],
  [/^water$/, { 'fill-color': NIGHT.water }],
  [/^aeroway_fill$/, { 'fill-color': NIGHT.aeroway }],
  [/^aeroway_/, { 'line-color': NIGHT.path }],
  [/^road_area_pattern$/, { 'fill-opacity': 0.08 }],
  // Roads, tunnels and bridges, by class. Casings first: their ids also name the class.
  [/motorway(_link)?_casing$/, { 'line-color': NIGHT.motorwayCasing }],
  [/(trunk_primary|secondary_tertiary|link)_casing$/, { 'line-color': NIGHT.primaryCasing }],
  [/(street|minor|service_track)_casing$/, { 'line-color': NIGHT.minorCasing }],
  [/path_pedestrian_casing$/, { 'line-color': NIGHT.minorCasing }],
  [/^(road|tunnel|bridge)_motorway(_link)?$/, { 'line-color': NIGHT.motorway }],
  [/^(road|tunnel|bridge)_trunk_primary$/, { 'line-color': NIGHT.primary }],
  [/^(road|tunnel|bridge)_(secondary_tertiary|link)$/, { 'line-color': NIGHT.secondary }],
  [/^(road|tunnel|bridge)_(minor|street|service_track)$/, { 'line-color': NIGHT.minor }],
  [/^(road|tunnel|bridge)_path_pedestrian$/, { 'line-color': NIGHT.path }],
  [/_(major|transit)_rail(_hatching)?$/, { 'line-color': NIGHT.rail }],
  [/^building$/, { 'fill-color': NIGHT.building, 'fill-outline-color': NIGHT.buildingLine }],
  [/^building-3d$/, { 'fill-extrusion-color': NIGHT.building, 'fill-extrusion-opacity': 0.6 }],
  [/^boundary_3$/, { 'line-color': NIGHT.boundaryState }],
  [/^boundary_/, { 'line-color': NIGHT.boundary }],
  // Labels: light text on a dark halo.
  [/^(waterway_line_label|water_name_)/, { 'text-color': NIGHT.waterLabel, 'text-halo-color': NIGHT.water }],
  [/^poi_/, { 'text-color': NIGHT.labelDim, 'text-halo-color': NIGHT.halo, 'icon-opacity': 0.75 }],
  [/^highway-name-/, { 'text-color': NIGHT.roadLabel, 'text-halo-color': NIGHT.halo, 'text-halo-width': 1 }],
  [/^airport$/, { 'text-color': NIGHT.labelDim, 'text-halo-color': NIGHT.halo }],
  [/^label_(city|city_capital|country_\d)$/, { 'text-color': NIGHT.label, 'text-halo-color': NIGHT.halo }],
  [/^label_(town|village)$/, { 'text-color': NIGHT.labelSoft, 'text-halo-color': NIGHT.halo }],
  [/^label_(state|other)$/, { 'text-color': NIGHT.labelDim, 'text-halo-color': NIGHT.halo }],
];

// Paint properties a layer type accepts, so an override never sets one that
// doesn't apply (MapLibre rejects the whole style over that).
const PAINT_PREFIX = { background: 'background-', fill: 'fill-', line: 'line-', symbol: ['text-', 'icon-'], raster: 'raster-', 'fill-extrusion': 'fill-extrusion-' };

function fits(type, prop) {
  const prefix = PAINT_PREFIX[type];
  if (!prefix) return false;
  const ok = [prefix].flat().some((p) => prop.startsWith(p));
  // "fill-extrusion-*" also starts with "fill-"; keep it to fill-extrusion layers.
  return ok && !(type === 'fill' && prop.startsWith('fill-extrusion-'));
}

// The night version of a liberty-style JSON (the input is left as is).
export function nightStyle(style) {
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const rule = RULES.find(([re]) => re.test(layer.id));
      if (!rule) return layer;
      const paint = { ...layer.paint };
      for (const [prop, value] of Object.entries(rule[1])) if (fits(layer.type, prop)) paint[prop] = value;
      const out = { ...layer, paint };
      // City dots are black in liberty; use the light one.
      if (layer.layout?.['icon-image'] && JSON.stringify(layer.layout['icon-image']).includes('circle_11_black')) {
        out.layout = { ...layer.layout, 'icon-image': JSON.parse(JSON.stringify(layer.layout['icon-image']).replaceAll('circle_11_black', 'circle_11')) };
      }
      return out;
    }),
  };
}

// --- the journal's map (docs/trips.md §20): minimal --------------------------------------------
// OpenFreeMap's Positron, cut down to land, water, the big roads as faint lines, country borders and
// city names, in a quiet light or dark palette, so the trip's numbered places are what you see.
export const POSITRON_STYLE = "https://tiles.openfreemap.org/styles/positron";
const QUIET = {
  light: { bg: "#f4f3ef", water: "#dbe4ec", road: "#e3e0d8", border: "#cbc7bf", text: "#6e7380", halo: "#f4f3ef" },
  dark: { bg: "#0e1322", water: "#0a1727", road: "#1a2234", border: "#283149", text: "#8a93a8", halo: "#0e1322" },
};
const KEEP = new Set(["background", "water", "highway_motorway_inner", "highway_major_inner", "boundary_2",
  "label_city", "label_city_capital", "label_town", "label_country_1", "label_country_2", "label_country_3", "water_name_point_label"]);
/** Positron, minimal: only the layers in KEEP, recoloured for the theme. */
export function minimalStyle(style, dark = true) {
  const c = dark ? QUIET.dark : QUIET.light;
  const layers = style.layers.filter((l) => KEEP.has(l.id)).map((l) => {
    if (l.type === "background") return { ...l, paint: { "background-color": c.bg } };
    if (l.type === "fill") return { ...l, paint: { ...l.paint, "fill-color": c.water, "fill-opacity": 1 } };
    if (l.type === "line") return { ...l, paint: { ...l.paint, "line-color": l.id.startsWith("boundary") ? c.border : c.road } };
    return { ...l, paint: { ...l.paint, "text-color": c.text, "text-halo-color": c.halo, "text-halo-width": 1.2 } };
  });
  return { ...style, layers };
}
