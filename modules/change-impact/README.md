# Change Impact

`@visionowl/change-impact` maps changed repository paths to graph nodes and then
adds their immediate upstream and downstream neighbors. VisionOwl can use this
small deterministic result to limit semantic analysis and document refreshes to
the part of a repository that may actually have changed.
