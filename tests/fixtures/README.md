# Synthetic video fixture

`synthetic.webm` is an original, two-second, silent graphic generated for this project's browser regression. It contains no course, personal video, lyrics or model output and is distributed under the root MIT license. Test users do not need FFmpeg.

To regenerate a new candidate, use a local FFmpeg with the VP8 and drawtext filters and a font available on your machine:

```sh
python tests/fixtures/generate.py --font /absolute/path/to/font.ttf --output work/new-synthetic.webm
```

Check the candidate by decoding it and running the browser regression before replacing the tracked fixture. The generator refuses to overwrite an existing output. Fonts are rendered into the image; no font file is included in this directory.
