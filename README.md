# Haiti Land Cover Explorer

A static web page that maps 2025 land cover across Haiti: Farmland, Forest, Water and Bare, at 20 m. You draw a rectangle or polygon, or upload a GeoJSON or KML file. The page then reports hectares and share per class, potential farmland, and mean model confidence, and lets you download the results as CSV or GeoJSON.

Everything runs in the browser. The map is a single Cloud-Optimized GeoTIFF in `data/` that the browser reads in pieces over HTTP range requests, so there is no server to run. Areas you draw never leave your browser.

## Status

**Preliminary.** The model was trained in one part of the Central Plateau. Outside it, results are rough. That is especially true for towns, since there is no built-up class, and for mangroves, the humid north and the dry northwest. An independent accuracy assessment is in progress.

## How the map is made

The map is built in the `land-classification` project (`scripts/national_map.py`):

1. **Imagery:** Sentinel-2 L2A cloud-masked median composites for three 2025 periods (pre-planting Feb–Mar, mid-season May–Jun, post-harvest Aug–Sep), from Microsoft Planetary Computer.
2. **Model:** a random forest on 105 band, index and season-statistic features. It is trained on Acceso field plots and digitised forest, bare and water polygons.
3. **Output:** class and confidence (the top class probability), aggregated to 20 m and written as a two-band COG plus `data/meta.json`.

No farmer or plot data is published here.

## Local preview

```
python serve.py
```

Then open http://localhost:8000. `serve.py` adds the HTTP Range support that GitHub Pages also provides.
