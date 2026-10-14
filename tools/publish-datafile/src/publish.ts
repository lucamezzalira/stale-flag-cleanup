import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

async function main(): Promise<void> {
  const build = spawnSync(
    "pnpm",
    ["--filter", "@stale-flags/featurevisor", "build"],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const bucket = process.env.DATAFILE_S3_BUCKET;
  if (!bucket) {
    console.log(
      "DATAFILE_S3_BUCKET unset; datafile built locally only (use pnpm datafile:serve).",
    );
    return;
  }

  const prefix = process.env.DATAFILE_S3_PREFIX ?? "featurevisor";
  const region = process.env.AWS_REGION ?? "eu-west-1";
  const key = `${prefix}/production/featurevisor-all.json`;
  const body = await readFile(
    path.join(root, "featurevisor/datafiles/production/featurevisor-all.json"),
  );
  const client = new S3Client({ region });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      CacheControl: "max-age=60",
    }),
  );
  console.log(`Uploaded s3://${bucket}/${key}`);
  if (process.env.DATAFILE_CLOUDFRONT_URL) {
    console.log(
      `App should use ${process.env.DATAFILE_CLOUDFRONT_URL}/production/featurevisor-all.json`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
