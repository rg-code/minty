# Tesseract.js 5.1.1 (Apache License 2.0: LICENSE-tesseract.js.md, LICENSE-tesseract.js-core)

Used only by SUB's screenshot reader (`/sub-scan`, docs/sub.md §2a) to read an offer's terms from a
screenshot in the browser; loaded only when a screenshot is picked, and never part of the service
worker's shell. Stored here, not loaded from a CDN, so the pages' policy stays `script-src 'self'`.
It runs as WebAssembly, so `/sub-scan` and these files get their own policy in `public/_headers`
(`'wasm-unsafe-eval'`); the dashboard's policy is unchanged.

Files, byte-identical to the npm packages:

    tesseract.min.js                  tesseract.js@5.1.1 dist/               sha256 a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8
    worker.min.js                     tesseract.js@5.1.1 dist/               sha256 aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc
    tesseract-core-simd-lstm.wasm.js  tesseract.js-core@5.1.1                 sha256 ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf
    eng.traineddata.gz                @tesseract.js-data/eng@1.0.0 4.0.0_best_int/   sha256 45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91

The English language data is Tesseract's own LSTM model (tesseract-ocr/tessdata_best, Apache-2.0),
as packaged by the tesseract.js project (MIT). Only the SIMD build is kept: every current browser
has WebAssembly SIMD (Safari 16.4 and later).
