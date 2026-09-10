import { canonicalJson } from "../domain/canonicalJson.js";
import { rawRecordId, sha256 } from "../domain/ids.js";
import type { RawRecord } from "../domain/types.js";
import type { GitHubFetched } from "../github/types.js";

export function createRawRecord(
  externalRepositoryId: string,
  repositoryId: string,
  resourceType: string,
  externalId: string | number,
  fetched: GitHubFetched<unknown>,
  fetchedAt = new Date().toISOString(),
): RawRecord {
  const checksum = sha256(canonicalJson(fetched.data));
  return {
    id: rawRecordId(externalRepositoryId, resourceType, externalId, checksum),
    provider: "github",
    repositoryId,
    resourceType,
    externalId: String(externalId),
    requestUrl: fetched.requestUrl,
    fetchedAt,
    etag: fetched.etag,
    checksum,
    payload: fetched.data,
  };
}
