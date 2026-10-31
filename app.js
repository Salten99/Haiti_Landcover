// Central Plateau Land Cover explorer: everything runs in the browser. The map is one Cloud-Optimized
// GeoTIFF (band 1 class, band 2 confidence 0-100, 255 = no data) read by HTTP range requests.

const DATA = "data/";
const MAX_PIXELS = 4e6; // larger areas are read from a coarser overview to stay responsive
const NODATA = 255;

const state = { meta: null, tiff: null, aoi: null, stats: null, view: "class", drawing: false };
const LOW_CONF = 50;

// viridis-like ramp for the confidence view (perceptually even, colour-blind safe): 0% -> yellow, 100% -> purple
const RAMP = [[253, 231, 37], [33, 145, 140], [68, 1, 84]];
const CONF_RGB = Array.from({ length: 101 }, (_, v) => {
  const t = (v / 100) * 2, i = Math.min(1, Math.floor(t)), f = t - i;
  return [...RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f)), 255];
});
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([18.95, -72.6], 8);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 18, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }
).addTo(map);
const drawn = new L.FeatureGroup().addTo(map);

const LandCoverLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const nw = map.unproject(coords.scaleBy(size), coords.z);
    const se = map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
    const b = state.meta.bounds;
    if (se.lng < b[0] || nw.lng > b[2] || se.lat > b[3] || nw.lat < b[1]) {
      done(null, tile);
      return tile;
    }
    // shortcut: linear latitude within a Web-Mercator tile; error is sub-pixel at Haiti's latitude
    state.tiff
      .readRasters({ bbox: [nw.lng, se.lat, se.lng, nw.lat], width: size.x, height: size.y,
                     samples: [state.view === "conf" ? 1 : 0], fillValue: NODATA, resampleMethod: "nearest" })
      .then((r) => {
        const ctx = tile.getContext("2d");
        const img = ctx.createImageData(size.x, size.y);
        const px = r[0];
        const lut = state.view === "conf" ? CONF_RGB : state.rgb;
        for (let i = 0; i < px.length; i++) {
          const c = lut[px[i]];
          if (!c) continue;
          img.data.set(c, i * 4);
        }
        ctx.putImageData(img, 0, 0);
        done(null, tile);
      })
      .catch((e) => done(e, tile));
    return tile;
  },
});

// ---------------------------------------------------------------- AOI input
const drawOpts = { shapeOptions: { color: "#ffd166", weight: 2, fillOpacity: 0.05 } };
$("draw-rect").onclick = () => new L.Draw.Rectangle(map, drawOpts).enable();
$("draw-poly").onclick = () => new L.Draw.Polygon(map, { ...drawOpts, allowIntersection: false }).enable();
map.on(L.Draw.Event.CREATED, (e) => setAoi(e.layer.toGeoJSON()));
map.on(L.Draw.Event.DRAWSTART, () => (state.drawing = true));
map.on(L.Draw.Event.DRAWSTOP, () => setTimeout(() => (state.drawing = false), 0)); // let the final click pass first

// click / tap a spot: what is mapped there
map.on("click", async (e) => {
  if (state.drawing || !state.tiff) return;
  const { lat, lng } = e.latlng, b = state.meta.bounds, r = state.meta.res / 2;
  let html = "Outside the mapped area.";
  if (lng > b[0] && lng < b[2] && lat > b[1] && lat < b[3]) {
    const [[c], [v]] = await state.tiff.readRasters({ bbox: [lng - r, lat - r, lng + r, lat + r], width: 1, height: 1,
                                                       samples: [0, 1], fillValue: NODATA, resampleMethod: "nearest" });
    const k = state.meta.classes.find((x) => x.code === c);
    html = k
      ? `<strong>${k.name}</strong><br>Model confidence ${v}%${v < LOW_CONF ? " (low)" : ""}`
      : "No data here (cloud in the 2025 images).";
  }
  L.popup().setLatLng(e.latlng)
    .setContent(`<div class="popup-class">${html}<br><span style="color:#777">${lat.toFixed(5)}, ${lng.toFixed(5)}</span></div>`)
    .openOn(map);
});

$("jump").onchange = (e) => {
  if (!e.target.value) return fitMapped();
  const [lat, lng] = e.target.value.split(",").map(Number);
  map.setView([lat, lng], 14);
};
$("banner-close").onclick = () => {
  $("banner").hidden = true;
  map.invalidateSize();
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
  if (!feature) {
    $("results-body").hidden = true;
    $("results-empty").hidden = false;
    $("results-empty").textContent = "Draw or upload an area to see its breakdown.";
    return;
  }
  const layer = L.geoJSON(feature, { style: drawOpts.shapeOptions }).addTo(drawn);
  map.fitBounds(layer.getBounds(), { padding: [30, 30] });
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
  document.querySelectorAll('input[name="view"]').forEach((el) => (el.onchange = (e) => {
    state.view = e.target.value;
    $("legend").hidden = state.view === "conf";
    $("conf-legend").hidden = state.view !== "conf";
    lc.redraw();
  }));
  $("legend").innerHTML = state.meta.classes
    .map((k) => `<li><span class="swatch" style="background:${k.color}"></span>${k.name}<span class="muted small"> · ${k.blurb}</span></li>`)
    .join("");
  $("about-meta").textContent = `Map version ${state.meta.version}. ${state.meta.sources}`;

  var lc = new LandCoverLayer({ opacity: +$("opacity").value, maxNativeZoom: 15, maxZoom: 18 }).addTo(map);
  $("opacity").oninput = (e) => lc.setOpacity(+e.target.value);
  const t = state.meta.training_bbox;
  L.rectangle([[t[1], t[0]], [t[3], t[2]]], { color: "#fff", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(map);
  fitMapped();
})().catch((err) => showError(`The map data failed to load: ${err.message}`));

function fitMapped() {
  map.invalidateSize(); // the banner can change the map's size after Leaflet first measured it
  const b = state.meta.bounds;
  map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { animate: false });
}
