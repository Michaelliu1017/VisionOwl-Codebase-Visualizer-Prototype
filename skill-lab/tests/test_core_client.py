from __future__ import annotations

import hashlib
import json
import unittest

import httpx

from skill_lab.core_client import CoreClient, CoreClientConfig


class CoreClientTests(unittest.TestCase):
    def test_uses_service_identity_and_hashes_artifact_upload(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "schemaVersion": "1.0",
                        "runId": "run-1",
                        "repositorySnapshots": [],
                    },
                )
            return httpx.Response(201, json={"artifactKey": "runs/run-1/result.json"})

        client = CoreClient(
            CoreClientConfig("http://core.local", "service-secret"),
            transport=httpx.MockTransport(handler),
        )
        try:
            command = client.get_command("run-1")
            receipt = client.upload_artifact(
                {**command, "artifactUploadPath": "/artifacts/{fileName}"},
                "result.json",
                b"result",
            )
        finally:
            client.close()

        self.assertEqual(receipt["artifactKey"], "runs/run-1/result.json")
        self.assertTrue(all(request.headers["x-visionowl-service-token"] == "service-secret" for request in requests))
        self.assertEqual(
            requests[-1].headers["x-content-sha256"],
            hashlib.sha256(b"result").hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
