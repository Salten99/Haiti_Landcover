// Central Plateau Land Cover explorer: everything runs in the browser. The map is one Cloud-Optimized
// GeoTIFF (band 1 class, band 2 confidence 0-100, 255 = no data) read by HTTP range requests.
// Two views of the same data: 3D terrain (MapLibre, default) and flat 2D (Leaflet, where drawing happens).

const DATA = "data/";
const MAX_PIXELS = 4e6; // larger areas are read from a coarser overview to stay responsive
const NODATA = 255;
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTR = "Imagery © Esri, Maxar, Earthstar Geographics";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const AOI_COLOR = "#ffd166";

const state = { meta: null, tiff: null, aoi: null, stats: null, view: "class", drawing: false, mode: "3d" };
const LOW_CONF = 50;

// viridis-like ramp for the confidence view (perceptually even, colour-blind safe): 0% -> yellow, 100% -> purple
const RAMP = [[253, 231, 37], [33, 145, 140], [68, 1, 84]];
const CONF_RGB = Array.from({ length: 101 }, (_, v) => {
  const t = (v / 100) * 2, i = Math.min(1, Math.floor(t)), f = t - i;
  return [...RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f)), 255];
});
const $ = (id) => document.getElementById(id);

// one map tile of the current view (land cover or confidence) for a lon/lat bbox, drawn into `canvas`
async function renderTile(canvas, [west, south, east, north]) {
  const b = state.meta.bounds;
  if (east < b[0] || west > b[2] || north < b[1] || south > b[3]) return canvas;
  // shortcut: linear latitude within a Web-Mercator tile; error is sub-pixel at Haiti's latitude
  const [px] = await state.tiff.readRasters({ bbox: [west, south, east, north], width: canvas.width, height: canvas.height,
                                              samples: [state.view === "conf" ? 1 : 0], fillValue: NODATA, resampleMethod: "nearest" });
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(canvas.width, canvas.height);
  const lut = state.view === "conf" ? CONF_RGB : state.rgb;
  for (let i = 0; i < px.length; i++) {
    const c = lut[px[i]];
    if (c) img.data.set(c, i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function tileBbox(z, x, y) {
  const n = 2 ** z, lon = (v) => (v / n) * 360 - 180;
  const lat = (v) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

// what is mapped at a spot, as popup HTML
async function inspect(lat, lng) {
  const b = state.meta.bounds, r = state.meta.res / 2;
  let html = "Outside the mapped area.";
  if (lng > b[0] && lng < b[2] && lat > b[1] && lat < b[3]) {
    const [[c], [v]] = await state.tiff.readRasters({ bbox: [lng - r, lat - r, lng + r, lat + r], width: 1, height: 1,
                                                       samples: [0, 1], fillValue: NODATA, resampleMethod: "nearest" });
    const k = state.meta.classes.find((x) => x.code === c);
    html = k
      ? `<strong>${k.name}</strong><br>Model confidence ${v}%${v < LOW_CONF ? " (low)" : ""}`
      : "No data here (cloud in the 2025 images).";
  }
  return `<div class="popup-class">${html}<br><span style="color:#777">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></div>`;
}

// ---------------------------------------------------------------- 2D map (Leaflet)
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([18.95, -72.6], 8);
L.tileLayer(ESRI, { maxZoom: 18, attribution: ESRI_ATTR }).addTo(map);
const drawn = new L.FeatureGroup().addTo(map);

const LandCoverLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const nw = map.unproject(coords.scaleBy(size), coords.z);
    const se = map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
    renderTile(tile, [nw.lng, se.lat, se.lng, nw.lat]).then(() => done(null, tile), (e) => done(e, tile));
    return tile;
  },
});

map.on("click", async (e) => {
  if (state.drawing || !state.tiff) return;
  L.popup().setLatLng(e.latlng).setContent(await inspect(e.latlng.lat, e.latlng.lng)).openOn(map);
});

// ---------------------------------------------------------------- 3D map (MapLibre + terrain)
maplibregl.addProtocol("lc", async (params) => {
  const [z, x, y] = params.url.split("/").slice(-3); // lc://<view>/{z}/{x}/{y}
  const canvas = await renderTile(Object.assign(document.createElement("canvas"), { width: 256, height: 256 }),
                                  tileBbox(+z, +x, +y));
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  return { data: await blob.arrayBuffer() };
});

const map3d = new maplibregl.Map({
  container: "map3d",
  style: {
    version: 8,
    sources: {
      esri: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 18, attribution: ESRI_ATTR },
      dem: { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: "terrarium",
             attribution: "Terrain: Mapzen / AWS Terrain Tiles" },
    },
    layers: [{ id: "esri", type: "raster", source: "esri" }],
    terrain: { source: "dem", exaggeration: 1.5 },
  },
  center: [-71.94, 18.95], zoom: 10, pitch: 60, bearing: -20, maxPitch: 80,
});
map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map3d.on("click", async (e) => {
  if (!state.tiff) return;
  new maplibregl.Popup().setLngLat(e.lngLat).setHTML(await inspect(e.lngLat.lat, e.lngLat.lng)).addTo(map3d);
});
// style.load, not load: "load" also waits for every visible imagery and terrain tile
const map3dReady = new Promise((res) => (map3d.isStyleLoaded() ? res() : map3d.once("style.load", res)));

function lcTiles() {
  return [`lc://${state.view}/{z}/{x}/{y}`];
}

function syncAoi3d() {
  const src = map3d.getSource("aoi");
  if (src) src.setData(state.aoi || { type: "FeatureCollection", features: [] });
}

// ---------------------------------------------------------------- switching views
function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === "2d") {
    const c = map3d.getCenter();
    $("map3d").hidden = true;
    $("map").hidden = false;
    map.invalidateSize();
    map.setView([c.lat, c.lng], Math.round(map3d.getZoom() + 1), { animate: false }); // MapLibre zoom is one level coarser
  } else {
    const c = map.getCenter();
    $("map").hidden = true;
    $("map3d").hidden = false;
    map3d.resize();
    map3d.jumpTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1 });
  }
  state.mode = mode;
  document.querySelectorAll("#mode-switch button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
}
document.querySelectorAll("#mode-switch button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function flyTo(lat, lng, zoom2d) {
  if (state.mode === "3d") map3d.flyTo({ center: [lng, lat], zoom: zoom2d - 1, pitch: 60 });
  else map.setView([lat, lng], zoom2d);
}

function fitMapped() {
  const b = state.meta.bounds;
  if (state.mode === "3d") map3d.fitBounds([[b[0], b[1]], [b[2], b[3]]], { pitch: 60, bearing: -20, padding: 40, duration: 0 });
  else {
    map.invalidateSize(); // the banner can change the map's size after Leaflet first measured it
    map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { animate: false });
  }
}

// ---------------------------------------------------------------- AOI input
const drawOpts = { shapeOptions: { color: AOI_COLOR, weight: 2, fillOpacity: 0.05 } };
function startDraw(Handler, opts) {
  setMode("2d"); // drawing on tilted terrain misplaces vertices, so draw in the flat view
  new Handler(map, opts).enable();
}
$("draw-rect").onclick = () => startDraw(L.Draw.Rectangle, drawOpts);
$("draw-poly").onclick = () => startDraw(L.Draw.Polygon, { ...drawOpts, allowIntersection: false });
map.on(L.Draw.Event.CREATED, (e) => setAoi(e.layer.toGeoJSON()));
map.on(L.Draw.Event.DRAWSTART, () => (state.drawing = true));
map.on(L.Draw.Event.DRAWSTOP, () => setTimeout(() => (state.drawing = false), 0)); // let the final click pass first

$("jump").onchange = (e) => {
  if (!e.target.value) return fitMapped();
  const [lat, lng] = e.target.value.split(",").map(Number);
  flyTo(lat, lng, 14);
};
$("banner-close").onclick = () => {
  $("banner").hidden = true;
  map.invalidateSize();
  map3d.resize();
};
$("clear").onclick = () => setAoi(null);

$("upload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const gj = file.name.toLowerCase().endsWith(".kml")
      ? toGeoJSON.kml(new DOMParser().parseFromString(text, "text/xml"))
      : JSON.parse(text);
    const polys = polygonsOf(gj);
    if (!polys.length) throw new Error("no polygon found");
    setAoi({ type: "Feature", properties: { source: file.name },
             geometry: { type: "MultiPolygon", coordinates: polys } });
  } catch (err) {
    showError(`Could not read ${file.name}: ${err.message}. Use a GeoJSON or KML file with polygons in longitude/latitude.`);
  }
  e.target.value = "";
};

function polygonsOf(gj) {
  const out = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === "FeatureCollection") g.features.forEach((f) => walk(f.geometry));
    else if (g.type === "Feature") walk(g.geometry);
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    else if (g.type === "Polygon") out.push(g.coordinates);
    else if (g.type === "MultiPolygon") out.push(...g.coordinates);
  };
  walk(gj);
  return out;
}

function setAoi(feature) {
  drawn.clearLayers();
  state.aoi = feature;
  state.stats = null;
  $("clear").hidden = !feature;
  syncAoi3d();
  if (!feature) {
    $("results-body").hidden = true;
    $("results-empty").hidden = false;
    $("results-empty").textContent = "Draw or upload an area to see its breakdown.";
    return;
  }
  const layer = L.geoJSON(feature, { style: drawOpts.shapeOptions }).addTo(drawn);
  const lb = layer.getBounds();
  if (state.mode === "3d") map3d.fitBounds([[lb.getWest(), lb.getSouth()], [lb.getEast(), lb.getNorth()]], { padding: 60, pitch: 55 });
  else map.fitBounds(lb, { padding: [30, 30] });
  analyse(feature).catch((err) => showError(`Analysis failed: ${err.message}`));
}

function showError(msg) {
  $("results-body").hidden = true;
  $("results-empty").hidden = false;
  $("results-empty").textContent = msg;
}

// ---------------------------------------------------------------- analysis
async function analyse(feature) {
  $("results-empty").hidden = false;
  $("results-empty").textContent = "Reading the map for your area…";
  $("results-body").hidden = true;

  const polys = polygonsOf(feature);
  let [x0, y0, x1, y1] = bboxOf(polys);
  const b = state.meta.bounds;
  [x0, y0, x1, y1] = [Math.max(x0, b[0]), Math.max(y0, b[1]), Math.min(x1, b[2]), Math.min(y1, b[3])];
  if (x0 >= x1 || y0 >= y1) return showError("That area is outside the mapped part of the Central Plateau.");

  const res = state.meta.res; // degrees per pixel at full resolution
  let w = Math.max(1, Math.round((x1 - x0) / res));
  let h = Math.max(1, Math.round((y1 - y0) / res));
  const scale = Math.max(1, Math.sqrt((w * h) / MAX_PIXELS));
  w = Math.max(1, Math.round(w / scale));
  h = Math.max(1, Math.round(h / scale));

  const [cls, conf] = await state.tiff.readRasters({
    bbox: [x0, y0, x1, y1], width: w, height: h, samples: [0, 1], fillValue: NODATA, resampleMethod: "nearest",
  });
  const inside = rasterizeMask(polys, [x0, y0, x1, y1], w, h);

  const dx = (x1 - x0) / w, dy = (y1 - y0) / h;
  const counts = new Float64Array(256);
  let confSum = 0, confArea = 0, lowArea = 0;
  for (let r = 0; r < h; r++) {
    const lat = y1 - (r + 0.5) * dy;
    const ha = (dx * 111320 * Math.cos((lat * Math.PI) / 180) * dy * 110574) / 1e4;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!inside[i]) continue;
      counts[cls[i]] += ha;
      if (cls[i] !== NODATA && conf[i] !== NODATA) {
        confSum += conf[i] * ha; confArea += ha;
        if (conf[i] < LOW_CONF) lowArea += ha;
      }
    }
  }

  const classes = state.meta.classes.map((k) => ({ ...k, ha: counts[k.code] }));
  const mapped = classes.reduce((s, k) => s + k.ha, 0);
  state.stats = {
    classes, mapped, nodata: counts[NODATA], meanConfidence: confArea ? confSum / confArea : null,
    lowShare: confArea ? lowArea / confArea : null,
    resolutionM: Math.round(dx * 111320 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)),
  };
  render(state.stats);
}

function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const ring of p) for (const [x, y] of ring) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

// polygon -> per-pixel inside flags, via an offscreen canvas (even-odd handles holes)
function rasterizeMask(polys, [x0, y0, x1, y1], w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  for (const p of polys) {
    ctx.beginPath();
    for (const ring of p) {
      ring.forEach(([x, y], k) => {
        const px = ((x - x0) / (x1 - x0)) * w, py = ((y1 - y) / (y1 - y0)) * h;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.closePath();
    }
    ctx.fill("evenodd");
  }
  const a = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = a[i * 4 + 3] > 127;
  return out;
}

// ---------------------------------------------------------------- output
const fmt = (v, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

function render(s) {
  $("results-empty").hidden = s.mapped > 0;
  $("results-body").hidden = !(s.mapped > 0);
  if (!(s.mapped > 0)) return showError("No mapped land in that area (cloud, or outside the map).");

  $("total-ha").textContent = fmt(s.mapped);
  const tbody = $("class-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const k of s.classes) {
    const share = k.ha / s.mapped;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch" style="background:${k.color}"></span>${k.name}</td>
      <td class="num">${fmt(k.ha)}</td>
      <td class="num"><span class="bar"><span style="width:${(share * 100).toFixed(1)}%;background:${k.color}"></span></span>${fmt(share * 100, 1)}%</td>`;
    tbody.appendChild(tr);
  }
  const pot = s.classes.filter((k) => k.potential).reduce((a, k) => a + k.ha, 0);
  $("potential").textContent = `${fmt(pot)} ha (${fmt((pot / s.mapped) * 100, 1)}%)`;
  $("confidence").textContent = s.meanConfidence == null ? "–" : `${fmt(s.meanConfidence)}%`;
  $("low-conf").textContent = s.lowShare == null ? "–" : `${fmt(s.lowShare * 100)}%`;
  $("nodata").textContent = `${fmt(s.nodata)} ha`;
  $("resolution").textContent = `${s.resolutionM} m pixels`;

  const warn = $("warning");
  warn.hidden = !(s.lowShare > 0.3);
  warn.textContent = `The model is unsure about ${fmt(s.lowShare * 100)}% of this area. Switch the map to "Model confidence" to see where, and check those spots on the imagery.`;
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function summaryRecord(s) {
  const rec = { status: "work_in_progress_not_validated", mapped_ha: +s.mapped.toFixed(2), nodata_ha: +s.nodata.toFixed(2) };
  for (const k of s.classes) {
    const key = k.name.toLowerCase().replace(/\W+/g, "_");
    rec[`${key}_ha`] = +k.ha.toFixed(2);
    rec[`${key}_pct`] = +((k.ha / s.mapped) * 100).toFixed(2);
  }
  rec.mean_confidence_pct = s.meanConfidence == null ? null : +s.meanConfidence.toFixed(1);
  rec.low_confidence_pct = s.lowShare == null ? null : +(s.lowShare * 100).toFixed(1);
  rec.resolution_m = s.resolutionM;
  rec.map_version = state.meta.version;
  rec.exported = new Date().toISOString().slice(0, 10);
  return rec;
}

$("dl-csv").onclick = () => {
  const rec = summaryRecord(state.stats);
  download("haiti_landcover_aoi.csv", `${Object.keys(rec).join(",")}\n${Object.values(rec).join(",")}\n`, "text/csv");
};
$("dl-geojson").onclick = () => {
  const f = { ...state.aoi, properties: { ...(state.aoi.properties || {}), ...summaryRecord(state.stats) } };
  download("haiti_landcover_aoi.geojson", JSON.stringify({ type: "FeatureCollection", features: [f] }), "application/geo+json");
};

// ---------------------------------------------------------------- boot
$("about-btn").onclick = () => $("about").showModal();
$("about-close").onclick = () => $("about").close();

(async function boot() {
  state.meta = await (await fetch(DATA + "meta.json")).json();
  state.tiff = await GeoTIFF.fromUrl(DATA + state.meta.file);
  state.rgb = {};
  for (const k of state.meta.classes) {
    const n = parseInt(k.color.slice(1), 16);
    state.rgb[k.code] = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  $("legend").innerHTML = state.meta.classes
    .map((k) => `<li><span class="swatch" style="background:${k.color}"></span>${k.name}<span class="muted small"> · ${k.blurb}</span></li>`)
    .join("");
  $("about-meta").textContent = `Map version ${state.meta.version}. ${state.meta.sources}`;

  const opacity = +$("opacity").value, b = state.meta.bounds, t = state.meta.training_bbox;
  const lc = new LandCoverLayer({ opacity, maxNativeZoom: 15, maxZoom: 18 }).addTo(map);
  L.rectangle([[t[1], t[0]], [t[3], t[2]]], { color: "#fff", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(map);

  await map3dReady;
  map3d.addSource("lc", { type: "raster", tiles: lcTiles(), tileSize: 256, maxzoom: 15, bounds: b });
  map3d.addLayer({ id: "lc", type: "raster", source: "lc", paint: { "raster-opacity": opacity, "raster-resampling": "nearest" } });
  map3d.addSource("outline", { type: "geojson", data: { type: "Polygon",
    coordinates: [[[t[0], t[1]], [t[2], t[1]], [t[2], t[3]], [t[0], t[3]], [t[0], t[1]]]] } });
  map3d.addLayer({ id: "outline", type: "line", source: "outline", paint: { "line-color": "#fff", "line-width": 1.5, "line-dasharray": [3, 2] } });
  map3d.addSource("aoi", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map3d.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": AOI_COLOR, "fill-opacity": 0.08 } });
  map3d.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": AOI_COLOR, "line-width": 2.5 } });
  syncAoi3d();

  $("opacity").oninput = (e) => {
    lc.setOpacity(+e.target.value);
    map3d.setPaintProperty("lc", "raster-opacity", +e.target.value);
  };
  document.querySelectorAll('input[name="view"]').forEach((el) => (el.onchange = (e) => {
    state.view = e.target.value;
    $("legend").hidden = state.view === "conf";
    $("conf-legend").hidden = state.view !== "conf";
    lc.redraw();
    map3d.getSource("lc").setTiles(lcTiles()); // a new URL per view, so cached tiles of the other view aren't reused
  }));
  fitMapped();
})().catch((err) => showError(`The map data failed to load: ${err.message}`));
