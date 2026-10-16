# Bengaluru transit data

Place a verified GTFS ZIP file in this folder as `bmtc_gtfs.zip`, then run:

```text
python scripts/import_gtfs.py data/bmtc_gtfs.zip
```

The command creates `data/bengaluru_transit.db`. It imports the standard GTFS files `stops.txt`, `routes.txt`, `trips.txt` and `stop_times.txt`.

Use a dated copy of the dataset and record its source in the final report. Validate the selected presentation routes against the Namma BMTC app or field observations, because schedule data can change.
