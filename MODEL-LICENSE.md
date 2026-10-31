# Model credits

`model/` contains the HTDemucs music source separation model in ONNX format, split into parts.

- Model and weights: HTDemucs by Meta Platforms, Inc., MIT License (https://github.com/facebookresearch/demucs)
- ONNX export: demucs-web by timcsy, MIT License (https://github.com/timcsy/demucs-web)

The file is unmodified apart from being split into 20 MB parts so it can be served from Cloudflare Pages.
