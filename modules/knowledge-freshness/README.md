# Knowledge Freshness

Determines whether a generated knowledge asset still matches the repository revision it describes.

The module marks an asset as stale when its source commit differs from the current commit, when its generation timestamp is invalid, or when it exceeds the configured maximum age.

## API

`assessKnowledgeFreshness(input)` returns:

- `status`: `fresh` or `stale`
- `reasons`: machine-readable reasons for a stale result
- `ageMs`: elapsed time since generation when the timestamp is valid

