#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ClaudePrReviewerStack } from './stack.js';

const app = new cdk.App();

new ClaudePrReviewerStack(app, 'ClaudePrReviewerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Claude PR Reviewer - GitHub App for automated PR reviews',
});

app.synth();
