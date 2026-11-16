# requests/

The Pages app saves one JSON file here per request; that push starts the
"Ingest and publish" workflow. Results and status go to the `data` branch.
See ../ingestion/src/ig_ingest/worker.py for the request formats.
