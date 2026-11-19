# MapLibre GL JS 5.24.0 (BSD-3-Clause: LICENSE.txt)

Used only by JET's map (`/jet/`, docs/trips.md §13), loaded on JET's pages and never on the
dashboard. Stored here, not loaded from a CDN, so the pages' policy stays `script-src 'self'`. It's
MapLibre's CSP build: the worker is its own file (`maplibre-gl.setWorkerUrl`), so no `blob:` worker
and no `eval`. The worker fetches OpenFreeMap's tiles under its own file's policy, which
`public/_headers` gives `connect-src https://tiles.openfreemap.org` (as `/jet/*`).

Files, byte-identical to the npm package `maplibre-gl@5.24.0` (`dist/`):

    maplibre-gl-csp.js         sha256 a1f1847bac64aa00acbf80fbb79b2c5af24d8eecaaa5e2ad14080fab81f1de95
    maplibre-gl-csp-worker.js  sha256 f950e7b15c49c8b9c7bb52136df2a2df2f6f03b83b8927774573fc98b067f7f0
    maplibre-gl.css            sha256 ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732
