import assert from "node:assert/strict";
import test from "node:test";

import {
  CoreServiceError,
  redactSensitiveData,
  redactSensitiveText,
  rewriteCoreText,
  rewriteCoreUrls,
  sendCoreError,
} from "../src/core-service/client.js";

test("redacts sensitive object fields recursively", () => {
  const sanitized = redactSensitiveData({
    apiKey: "secret-value",
    model: "public-model-id",
    nested: {
      access_token: "nested-secret",
      clientSecret: "client-secret",
      private_key: "private-key",
      secretKey: "secret-key",
      aws_access_key_id: "aws-access-key",
      aws_secret_access_key: "aws-secret-key",
      baseURL: "https://api.example.com/v1",
    },
  });

  assert.deepEqual(sanitized, {
    apiKey: "[REDACTED]",
    model: "public-model-id",
    nested: {
      access_token: "[REDACTED]",
      clientSecret: "[REDACTED]",
      private_key: "[REDACTED]",
      secretKey: "[REDACTED]",
      aws_access_key_id: "[REDACTED]",
      aws_secret_access_key: "[REDACTED]",
      baseURL: "https://api.example.com/v1",
    },
  });
});

test("redacts credentials embedded in text", () => {
  assert.equal(
    redactSensitiveText("Authorization: Bearer abc.def-123"),
    "Authorization: [REDACTED]",
  );
  assert.equal(
    redactSensitiveText(
      `provider failed with ${["sk", "example1234567890"].join("-")}`,
    ),
    "provider failed with [REDACTED]",
  );
  assert.equal(
    redactSensitiveText("Design token: primary color"),
    "Design token: primary color",
  );
  assert.equal(
    redactSensitiveText("const secret = revealOnHover; Secret: Garden"),
    "const secret = revealOnHover; Secret: Garden",
  );
  assert.equal(
    redactSensitiveText("provider failed token=plain-secret"),
    "provider failed token=[REDACTED]",
  );
  for (const label of ["password", "credentials", "secretKey", "private_key"]) {
    assert.equal(
      redactSensitiveText(`${label}=plain-secret`),
      `${label}=[REDACTED]`,
    );
  }
  assert.equal(
    redactSensitiveText('client_secret="plain secret" status=failed'),
    "client_secret=[REDACTED] status=failed",
  );
});

test("redacts core payloads while preserving public fields and URL rewrites", () => {
  process.env.SVG_TRANSFORM_CORE_URL = "http://127.0.0.1:4310";

  assert.deepEqual(
    rewriteCoreUrls({
      apiKey: "secret-value",
      model: "public-model-id",
      previewUrl: "http://127.0.0.1:4310/api/jobs/job-1/preview",
      token_usage: { input_tokens: 12, output_tokens: 4 },
    }),
    {
      apiKey: "[REDACTED]",
      model: "public-model-id",
      previewUrl: "/transformer/api/jobs/job-1/preview",
      token_usage: { input_tokens: 12, output_tokens: 4 },
    },
  );

  assert.equal(
    rewriteCoreText(
      'data: {"authorization":"Bearer abc.def-123","url":"/api/jobs/job-1"}',
    ),
    'data: {"authorization":"[REDACTED]","url":"/transformer/api/jobs/job-1"}',
  );

  const rewrittenEvent = rewriteCoreText(
    'data: {"message":"provider apiKey=plain-secret","status":"failed"}',
  );
  const eventPayload = JSON.parse(rewrittenEvent.slice("data: ".length)) as {
    message: string;
    status: string;
  };
  assert.deepEqual(eventPayload, {
    message: "provider apiKey=[REDACTED]",
    status: "failed",
  });

  const quotedSecretEvent = rewriteCoreText(
    `data: ${JSON.stringify({
      message: 'client_secret="plain secret" status=failed',
      status: "failed",
    })}`,
  );
  assert.deepEqual(
    JSON.parse(quotedSecretEvent.slice("data: ".length)),
    {
      message: "client_secret=[REDACTED] status=failed",
      status: "failed",
    },
  );
});

test("redacts plain-text core errors before sending them", () => {
  let statusCode = 0;
  let payload: unknown;
  const response = {
    json(value: unknown) {
      payload = value;
      return this;
    },
    status(value: number) {
      statusCode = value;
      return this;
    },
  };

  sendCoreError(
    response as never,
    new CoreServiceError("provider apiKey=plain-secret", 502, "plain failure"),
  );

  assert.equal(statusCode, 502);
  assert.deepEqual(payload, { error: "provider apiKey=[REDACTED]" });
});
