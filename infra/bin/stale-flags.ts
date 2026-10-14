#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { StaleFlagsStack } from "../lib/stale-flags-stack";

const app = new cdk.App();

new StaleFlagsStack(app, "StaleFlagsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Stale Featurevisor flag cleanup PoC (web, datafiles, scheduled agent)",
});
