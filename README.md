# Central Plateau Land Cover (Haiti)

A static web page that maps 2025 land cover in about 2,200 km² of Haiti's Central Plateau: Farmland, Forest, Water and Bare, at 20 m. You draw a rectangle or polygon, or upload a GeoJSON or KML file. The page then reports hectares and share per class, potential farmland, and mean model confidence, and lets you download the results as CSV or GeoJSON.

Everything runs in the browser. The map is a single Cloud-Optimized GeoTIFF in `data/` that the browser reads in pieces over HTTP range requests, so there is no server to run. Areas you draw never leave your browser.

## Status

**Preliminary.** The model is trained and applied in the same Central Plateau area, with about 75% accuracy in spatial cross-validation. An independent accuracy assessment is in progress. A country-wide version is planned once the imagery-source question is settled (see `national_map.py`).

## How the map is made

The map is built in the `land-classification` project (`scripts/national_map.py`):

1. **Imagery:** Sentinel-2 L2A cloud-masked median composites for three 2025 periods (pre-planting Feb–Mar, mid-season May–Jun, post-harvest Aug–Sep), from Google Earth Engine.
2. **Model:** a random forest on 105 band, index and season-statistic features. It is trained on Acceso field plots and digitised forest, bare and water polygons.
3. **Output:** the production class map plus confidence (the model's probability for the mapped class), aggregated to 20 m and written as a two-band COG plus `data/meta.json` (`national_map.py export-study`).

No farmer or plot data is published here.

## Local preview

```
python serve.py
```

Then open http://localhost:8000. `serve.py` adds the HTTP Range support that GitHub Pages also provides.
