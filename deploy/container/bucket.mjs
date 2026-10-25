import { S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: process.env.PRONTO_S3_ENDPOINT, region: process.env.AWS_REGION,
  forcePathStyle: true, maxAttempts: 1,
});
const Bucket = process.env.PRONTO_BUCKET;
try {
  try { await client.send(new HeadBucketCommand({ Bucket })); }
  catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    try { await client.send(new CreateBucketCommand({ Bucket })); }
    catch (error) { if (error.name !== "BucketAlreadyOwnedByYou") throw error; }
  }
  console.log(`Bucket ${Bucket} exists and is accessible`);
} finally { client.destroy(); }
