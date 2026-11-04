// Central Plateau Land Cover explorer: everything runs in the browser. The map is one Cloud-Optimized
// GeoTIFF (band 1 class, band 2 confidence 0-100, 255 = no data) read by HTTP range requests.
// Two views of the same data: 3D terrain (MapLibre, default) and flat 2D (Leaflet, where drawing happens).
// The URL hash keeps view, layer, position and a drawn area, so a link reopens exactly what was on screen.

const DATA = "data/";
const MAX_PIXELS = 4e6; // larger areas are read from a coarser overview to stay responsive
const NODATA = 255;
const LOW_CONF = 50;
const OPEN_LAND = 3;
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTR = "Imagery © Esri, Maxar, Earthstar Geographics";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PHONE = matchMedia("(max-width: 760px)");

const state = { meta: null, tiff: null, aoi: null, stats: null, view: "class", mode: "3d", drawing: null, firstTile: false };
const $ = (id) => document.getElementById(id);

// single-hue ramp for the confidence view (light = unsure, deep = sure); it never starts at farmland gold
const RAMP = [[242, 232, 250], [155, 111, 192], [59, 10, 94]];
const CONF_RGB = Array.from({ length: 101 }, (_, v) => {
  const t = (v / 100) * 2, i = Math.min(1, Math.floor(t)), f = t - i;
  return [...RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f)), 255];
});
const HATCH = [156, 146, 133, 255]; // Open land stripes: a second cue besides colour

// ---------------------------------------------------------------- tiles
// one map tile of the current view for a lon/lat bbox, drawn into `canvas`
async function renderTile(canvas, [west, south, east, north], from, view = state.view) {
  const b = state.meta.bounds;
  if (east < b[0] || west > b[2] || north < b[1] || south > b[3]) return canvas;
  const w = canvas.width, h = canvas.height;
  // shortcut: linear latitude within a Web-Mercator tile; error is sub-pixel at Haiti's latitude
  const [cls, conf] = await state.tiff.readRasters({ bbox: [west, south, east, north], width: w, height: h,
                                                     samples: [0, 1], fillValue: NODATA, resampleMethod: "nearest" })
    .catch((err) => {
      if (from === state.mode) mapError(`Some of the land cover didn't load (${err.message}). Check your connection and reload the page.`);
      throw err;
    });
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  let painted = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === NODATA) continue;
    let c;
    if (view === "conf") c = CONF_RGB[conf[i]];
    else {
      const x = i % w, y = (i / w) | 0;
      c = cls[i] === OPEN_LAND && (x + y) % 8 < 2 ? HATCH : state.rgb[cls[i]];
      if (c && conf[i] < LOW_CONF) c = [c[0], c[1], c[2], 110]; // faded = the model is unsure
    }
    if (c) { img.data.set(c, i * 4); painted++; }
  }
  ctx.putImageData(img, 0, 0);
  if (painted) tilesSettled(from);
  return canvas;
}

// also runs when a map finishes loading: a view with no land cover never paints a tile
function tilesSettled(from) {
  if (!state.firstTile && from === state.mode) firstTileShown(); // the hidden map doesn't count
}

function tileBbox(z, x, y) {
  const n = 2 ** z, lon = (v) => (v / n) * 360 - 180;
  const lat = (v) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function firstTileShown() {
  state.firstTile = true;
  if (!$("map-status").classList.contains("error")) $("map-status").classList.add("done"); // failed tiles need a reload
  // terrain loads only after the land cover is visible, so a slow connection sees the answer first
  map3dReady.then(() => {
    const addTerrain = () => map3d.setTerrain({ source: "dem", exaggeration: 1.4 });
    // terrain added mid-flight throws inside MapLibre's frame and freezes the map for good
    if (map3d.isMoving()) map3d.once("moveend", addTerrain);
    else addTerrain();
  });
}

function mapError(msg) {
  const el = $("map-status");
  el.classList.remove("done");
  el.classList.add("error");
  $("map-status-msg").textContent = msg;
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
      ? `<strong>${k.name}</strong><br>Model confidence ${v}%${v < LOW_CONF ? " (unsure)" : ""}`
      : "No data here: cloud in the 2025 images.";
  }
  $("inspect-live").textContent = html.replace(/<br>/g, ". ").replace(/<[^>]+>/g, ""); // popups aren't announced
  return `<div class="popup-class">${html}<br><span class="coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></div>`;
}

// ---------------------------------------------------------------- 2D map (Leaflet)
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([18.95, -71.94], 10);
L.tileLayer(ESRI, { maxZoom: 18, attribution: ESRI_ATTR }).addTo(map);
const drawn = new L.FeatureGroup().addTo(map);
const AOI_HALO = { color: "#16201a", weight: 6, opacity: 0.55, fill: false };
const AOI_LINE = { color: "#ffffff", weight: 2.5, fillColor: "#ffffff", fillOpacity: 0.06 };

const LandCoverLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const nw = map.unproject(coords.scaleBy(size), coords.z);
    const se = map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
    renderTile(tile, [nw.lng, se.lat, se.lng, nw.lat], "2d").then(() => done(null, tile), (e) => done(e, tile));
    return tile;
  },
});

map.on("click", async (e) => {
  if (state.drawing || !state.tiff) return;
  L.popup().setLatLng(e.latlng).setContent(await inspect(e.latlng.lat, e.latlng.lng)).openOn(map);
});
map.on("moveend", writeHash);

// ---------------------------------------------------------------- 3D map (MapLibre + terrain)
maplibregl.addProtocol("lc", async (params) => {
  const [view, z, x, y] = params.url.split("/").slice(-4); // lc://<view>/{z}/{x}/{y}
  const canvas = await renderTile(Object.assign(document.createElement("canvas"), { width: 256, height: 256 }),
                                  tileBbox(+z, +x, +y), "3d", view);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  return { data: await blob.arrayBuffer() };
});

// No WebGL (old phones, locked-down browsers): fall back to 2D. The stub swallows every 3D call, so the
// rest of the code doesn't need a guard at each use.
const HAS_WEBGL = (() => {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); }
  catch { return false; }
})();
const NO_3D = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : NO_3D), apply: () => NO_3D });
const map3d = !HAS_WEBGL ? NO_3D : new maplibregl.Map({
  container: "map3d",
  style: {
    version: 8,
    sources: {
      esri: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 18, attribution: ESRI_ATTR },
      dem: { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: "terrarium",
             attribution: "Terrain: Mapzen / AWS Terrain Tiles" },
    },
    layers: [{ id: "esri", type: "raster", source: "esri" }],
  },
  center: [-71.94, 18.95], zoom: 9.6, pitch: 35, bearing: -15, maxPitch: 75,
});
map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map3d.on("click", async (e) => {
  if (!state.tiff) return;
  new maplibregl.Popup().setLngLat(e.lngLat).setHTML(await inspect(e.lngLat.lat, e.lngLat.lng)).addTo(map3d);
});
map3d.on("moveend", writeHash);
// style.load, not load: "load" also waits for every visible imagery and terrain tile
const map3dReady = HAS_WEBGL ? new Promise((res) => (map3d.isStyleLoaded() ? res() : map3d.once("style.load", res)))
  : new Promise(() => {});

const lcTiles = () => [`lc://${state.view}/{z}/{x}/{y}`];

function syncAoi3d() {
  const src = map3d.getSource("aoi");
  if (src) src.setData(state.aoi || { type: "FeatureCollection", features: [] });
}

// keyboard: Enter on a focused map inspects its centre
$("map3d").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !state.tiff) return;
  const c = map3d.getCenter();
  new maplibregl.Popup().setLngLat(c).setHTML(await inspect(c.lat, c.lng)).addTo(map3d);
});
$("map").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !state.tiff || state.drawing) return;
  const c = map.getCenter();
  L.popup().setLatLng(c).setContent(await inspect(c.lat, c.lng)).openOn(map);
});

// ---------------------------------------------------------------- views
function setMode(mode) {
  if (mode === state.mode) return;
  if (!HAS_WEBGL) {
    // nothing to carry over from the 3D stub
  } else if (mode === "2d") {
    const c = map3d.getCenter();
    map.setView([c.lat, c.lng], Math.round(map3d.getZoom() + 1), { animate: false }); // MapLibre zoom is one level coarser
  } else {
    const c = map.getCenter();
    map3d.jumpTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1 });
  }
  $("map").classList.toggle("is-off", mode !== "2d");
  $("map3d").classList.toggle("is-off", mode !== "3d");
  $("map-wrap").dataset.mode = mode;
  state.mode = mode;
  map.invalidateSize();
  map3d.resize();
  document.querySelectorAll("#mode-switch button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  writeHash();
}
document.querySelectorAll("#mode-switch button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function setView(view) {
  state.view = view;
  document.querySelector(`input[name="view"][value="${view}"]`).checked = true;
  $("legend").hidden = view === "conf";
  $("conf-legend").hidden = view !== "conf";
  state.lc.redraw();
  map3d.getSource("lc")?.setTiles(lcTiles()); // a new URL per view, so cached tiles of the other view aren't reused
  writeHash();
}

function flyTo(lat, lng, zoom2d) {
  if (state.mode === "3d") map3d[REDUCED_MOTION ? "jumpTo" : "flyTo"]({ center: [lng, lat], zoom: zoom2d - 1 });
  else map.setView([lat, lng], zoom2d, { animate: !REDUCED_MOTION });
}

function fitBox([x0, y0, x1, y1], padding) {
  if (state.mode === "3d") map3d.fitBounds([[x0, y0], [x1, y1]], { padding, duration: REDUCED_MOTION ? 0 : 600 });
  else {
    map.invalidateSize();
    map.fitBounds([[y0, x0], [y1, x1]], { padding: [padding / 2, padding / 2], animate: false });
  }
}
const fitMapped = () => fitBox(state.meta.bounds, 40);

// ---------------------------------------------------------------- drawing
const DRAW_TOOLS = {
  rect: { button: "draw-rect", Handler: () => L.Draw.Rectangle, msg: "Drag on the map to draw a rectangle" },
  poly: { button: "draw-poly", Handler: () => L.Draw.Polygon, msg: "Tap each corner; tap the first point to finish" },
};

function startDraw(kind) {
  stopDraw();
  setMode("2d"); // drawing on tilted terrain misplaces vertices, so draw in the flat view
  const tool = DRAW_TOOLS[kind];
  const Handler = tool.Handler();
  state.drawing = new Handler(map, { shapeOptions: AOI_LINE, allowIntersection: false });
  state.drawing.enable();
  $(tool.button).setAttribute("aria-pressed", "true");
  $("draw-msg").textContent = tool.msg;
  $("draw-bar").hidden = false;
}

function stopDraw() {
  if (state.drawing) state.drawing.disable();
  state.drawing = null;
  Object.values(DRAW_TOOLS).forEach((t) => $(t.button).setAttribute("aria-pressed", "false"));
  $("draw-bar").hidden = true;
}

$("draw-rect").onclick = () => startDraw("rect");
$("draw-poly").onclick = () => startDraw("poly");
$("draw-cancel").onclick = stopDraw;
map.on(L.Draw.Event.CREATED, (e) => setAoi(e.layer.toGeoJSON()));
map.on(L.Draw.Event.DRAWSTOP, () => setTimeout(stopDraw, 0)); // after the final click, so it isn't read as an inspect

// ---------------------------------------------------------------- AOI input
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
$("show-where").onclick = () => setView("conf");

$("upload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const gj = file.name.toLowerCase().endsWith(".kml")
      ? toGeoJSON.kml(new DOMParser().parseFromString(text, "text/xml"))
      : JSON.parse(text);
    const polys = polygonsOf(gj);
    if (!polys.length) throw new Error("it has no polygons");
    setAoi({ type: "Feature", properties: { source: file.name },
             geometry: { type: "MultiPolygon", coordinates: polys } });
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${err.message}. Upload a GeoJSON or KML file with polygons in longitude/latitude.`, "error");
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

function setAoi(feature, { fit = true } = {}) {
  drawn.clearLayers();
  state.aoi = feature;
  state.stats = null;
  syncAoi3d();
  writeHash();
  $("results-body").hidden = true;
  if (!feature) return setStatus("Draw or upload an area to see its breakdown.");
  L.geoJSON(feature, { style: AOI_HALO, interactive: false }).addTo(drawn);
  const layer = L.geoJSON(feature, { style: AOI_LINE, interactive: false }).addTo(drawn);
  const lb = layer.getBounds();
  if (fit) fitBox([lb.getWest(), lb.getSouth(), lb.getEast(), lb.getNorth()], 60);
  analyse(feature).catch((err) => {
    if (state.aoi === feature) setStatus(`The analysis failed (${err.message}). Try a smaller area, or reload the page.`, "error");
  });
}

function setStatus(msg, kind = "") {
  $("status").textContent = msg;
  $("status").className = `status ${kind}`;
  $("status").hidden = false;
}

// ---------------------------------------------------------------- analysis
async function analyse(feature) {
  setStatus("Reading the map for your area…");
  const polys = polygonsOf(feature);
  let [x0, y0, x1, y1] = bboxOf(polys);
  const b = state.meta.bounds;
  [x0, y0, x1, y1] = [Math.max(x0, b[0]), Math.max(y0, b[1]), Math.min(x1, b[2]), Math.min(y1, b[3])];
  if (x0 >= x1 || y0 >= y1) return setStatus("That area is outside the mapped part of the Central Plateau. Draw inside the dashed line.", "error");

  const res = state.meta.res; // degrees per pixel at full resolution
  let w = Math.max(1, Math.round((x1 - x0) / res));
  let h = Math.max(1, Math.round((y1 - y0) / res));
  const scale = Math.max(1, Math.sqrt((w * h) / MAX_PIXELS));
  w = Math.max(1, Math.round(w / scale));
  h = Math.max(1, Math.round(h / scale));

  const [cls, conf] = await state.tiff.readRasters({
    bbox: [x0, y0, x1, y1], width: w, height: h, samples: [0, 1], fillValue: NODATA, resampleMethod: "nearest",
  });
  if (state.aoi !== feature) return; // the area changed while this one was being read
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
// on screen, hectares are rounded to tens: the map is an estimate (exports keep full precision)
const ha10 = (v) => (v >= 10 ? `≈ ${fmt(Math.round(v / 10) * 10)}` : fmt(v, 1));

function render(s) {
  if (!(s.mapped > 0)) return setStatus("No mapped land in that area: it's cloud or outside the map.", "error");
  const pot = s.classes.filter((k) => k.potential).reduce((a, k) => a + k.ha, 0);
  setStatus(`Done. ${ha10(s.mapped)} hectares analysed; potential farmland ${fmt((pot / s.mapped) * 100)}%.`);
  $("status").className = "status sr-only"; // still announced; the headline below says it visually
  $("results-body").hidden = false;

  $("potential").textContent = `${ha10(pot)} ha`;
  const part = (code) => s.classes.find((k) => k.code === code).ha;
  $("potential-sub").textContent = `${ha10(part(0))} ha farmland plus ${ha10(part(OPEN_LAND))} ha open land `
    + `(grass, shrub, rock, roads, buildings): ${fmt((pot / s.mapped) * 100)}% of the ${ha10(s.mapped)} ha analysed`;
  const tbody = $("class-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const k of s.classes) {
    const share = k.ha / s.mapped;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch${k.code === OPEN_LAND ? " hatch" : ""}" style="background-color:${k.color}" aria-hidden="true"></span>${k.name}</td>
      <td class="num">${ha10(k.ha)}</td>
      <td class="num"><span class="bar" aria-hidden="true"><span style="width:${(share * 100).toFixed(1)}%;background:${k.color}"></span></span>${fmt(share * 100)}%</td>`;
    tbody.appendChild(tr);
  }
  $("confidence").textContent = s.meanConfidence == null ? "–" : `${fmt(s.meanConfidence)}%`;
  $("low-conf").textContent = s.lowShare == null ? "–" : `${fmt(s.lowShare * 100)}%`;
  $("nodata-row").hidden = !(s.nodata > 0.5);
  $("nodata").textContent = `${ha10(s.nodata)} ha`;
  const warn = $("warning");
  warn.hidden = !(s.lowShare > 0.3);
  warn.textContent = `The model is unsure about ${fmt(s.lowShare * 100)}% of this area. Check those spots on the imagery before relying on the totals.`;
  if (PHONE.matches) { // scroll the panel only; scrollIntoView would also scroll the fixed page
    const panel = document.querySelector(".panel");
    const top = panel.scrollTop + $("results").getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollTo({ top, behavior: REDUCED_MOTION ? "auto" : "smooth" });
  }
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function summaryRecord(s) {
  const rec = { status: "work_in_progress_not_validated", area_source: state.aoi.properties?.source || "drawn on map",
                mapped_ha: +s.mapped.toFixed(2), nodata_ha: +s.nodata.toFixed(2) };
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

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
$("dl-csv").onclick = () => {
  const rec = summaryRecord(state.stats);
  download("haiti_landcover_area.csv", `${Object.keys(rec).join(",")}\n${Object.values(rec).map(csvCell).join(",")}\n`, "text/csv");
};
$("dl-geojson").onclick = () => {
  const f = { ...state.aoi, properties: { ...(state.aoi.properties || {}), ...summaryRecord(state.stats) } };
  download("haiti_landcover_area.geojson", JSON.stringify({ type: "FeatureCollection", features: [f] }), "application/geo+json");
};

// ---------------------------------------------------------------- shareable URL
// #m=3d&v=class&c=lat,lng,zoom2d&a=lng,lat;lng,lat;... (a = one drawn ring, only if it's small enough)
let hashTimer;
function writeHash() {
  if (!state.meta) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = state.mode === "3d" ? map3d.getCenter() : map.getCenter();
    const z = state.mode === "3d" ? map3d.getZoom() + 1 : map.getZoom();
    const p = new URLSearchParams({ m: state.mode, v: state.view, c: `${c.lat.toFixed(5)},${c.lng.toFixed(5)},${z.toFixed(1)}` });
    const source = state.aoi?.properties?.source;
    const polys = state.aoi && (!source || source === "shared link") ? polygonsOf(state.aoi) : []; // uploads stay out of the URL
    if (polys.length === 1 && polys[0].length === 1 && polys[0][0].length <= 100) {
      p.set("a", polys[0][0].map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(";"));
    }
    history.replaceState(null, "", `#${p}`);
  }, 300);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const out = { mode: p.get("m"), view: p.get("v") };
  const c = (p.get("c") || "").split(",").map(Number);
  if (c.length === 3 && c.every(Number.isFinite) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180) out.center = c;
  const ring = (p.get("a") || "").split(";").map((s) => s.split(",").map(Number)).filter((v) => v.length === 2 && v.every(Number.isFinite));
  if (ring.length >= 4) out.aoi = { type: "Feature", properties: { source: "shared link" }, geometry: { type: "Polygon", coordinates: [ring] } };
  return out;
}

// ---------------------------------------------------------------- boot
$("about-btn").onclick = () => $("about").showModal();
$("about-close").onclick = () => $("about").close();

(async function boot() {
  const h = readHash(); // before anything moves the map and rewrites the hash
  state.meta = await (await fetch(DATA + "meta.json")).json();
  state.tiff = await GeoTIFF.fromUrl(DATA + state.meta.file);
  state.rgb = {};
  for (const k of state.meta.classes) {
    const n = parseInt(k.color.slice(1), 16);
    state.rgb[k.code] = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  $("legend").innerHTML = state.meta.classes
    .map((k) => `<li><span class="swatch${k.code === OPEN_LAND ? " hatch" : ""}" style="background-color:${k.color}" aria-hidden="true"></span>`
      + `<span class="what">${k.name}</span><span class="blurb">${k.blurb}</span></li>`)
    .join("") + `<li><span class="swatch" style="background-color:#d9a21f;opacity:.45" aria-hidden="true"></span>`
      + `<span class="what">Faded colour</span><span class="blurb">the model is unsure (under 50% confidence)</span></li>`;
  $("about-meta").textContent = `Map version ${state.meta.version}. ${state.meta.sources}`;

  const opacity = +$("opacity").value, t = state.meta.training_bbox;
  state.lc = new LandCoverLayer({ opacity, maxNativeZoom: 15, maxZoom: 18 }).addTo(map);
  state.lc.on("load", () => tilesSettled("2d"));
  L.rectangle([[t[1], t[0]], [t[3], t[2]]], { color: "#fff", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(map);

  $("opacity").oninput = (e) => {
    const v = +e.target.value;
    state.lc.setOpacity(v);
    if (map3d.getLayer("lc")) map3d.setPaintProperty("lc", "raster-opacity", v);
    $("opacity-out").textContent = `${Math.round(v * 100)}%`;
  };
  document.querySelectorAll('input[name="view"]').forEach((el) => (el.onchange = (e) => setView(e.target.value)));

  // 3D layers attach whenever the 3D map is ready; nothing else waits for it
  map3dReady.then(() => {
    map3d.resize(); // the container may have been measured before style.css applied
    map3d.addSource("lc", { type: "raster", tiles: lcTiles(), tileSize: 256, maxzoom: 15, bounds: state.meta.bounds });
    map3d.addLayer({ id: "lc", type: "raster", source: "lc", paint: { "raster-opacity": +$("opacity").value, "raster-resampling": "nearest" } });
    map3d.addSource("outline", { type: "geojson", data: { type: "Polygon",
      coordinates: [[[t[0], t[1]], [t[2], t[1]], [t[2], t[3]], [t[0], t[3]], [t[0], t[1]]]] } });
    map3d.addLayer({ id: "outline", type: "line", source: "outline", paint: { "line-color": "#fff", "line-width": 1.5, "line-dasharray": [3, 2] } });
    map3d.addSource("aoi", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map3d.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": "#fff", "fill-opacity": 0.06 } });
    map3d.addLayer({ id: "aoi-halo", type: "line", source: "aoi", paint: { "line-color": "#16201a", "line-width": 6, "line-opacity": 0.55 } });
    map3d.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": "#fff", "line-width": 2.5 } });
    syncAoi3d();
    map3d.on("idle", () => tilesSettled("3d"));
  });

  // restore a shared link, else show the whole mapped area
  if (h.view === "conf") setView("conf");
  if (h.mode === "2d" || !HAS_WEBGL) setMode("2d");
  if (!HAS_WEBGL) $("mode-switch").hidden = true;
  if (h.center) flyToNow(h.center);
  else if (!$("jump").value) fitMapped(); // don't undo a place picked while the page was loading
  if (h.aoi) setAoi(h.aoi, { fit: !h.center });
  writeHash();
  setTimeout(() => { if (!state.firstTile && !$("map-status").classList.contains("error")) $("map-status-msg").textContent = "Still loading land cover… (slow connection)"; }, 8000);
})().catch((err) => mapError(`The map data didn't load (${err.message}). Check your connection and reload the page.`));

function flyToNow([lat, lng, z2d]) {
  if (state.mode === "3d") map3d.jumpTo({ center: [lng, lat], zoom: z2d - 1 });
  else map.setView([lat, lng], z2d, { animate: false });
}
