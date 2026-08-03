"use strict";

module.exports = {
  ...require("./path-normalizer"),
  ...require("./sanitize-graph"),
  ...require("./secret-scanner"),
  ...require("./validate-artifact"),
};
