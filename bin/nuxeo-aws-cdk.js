#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { NuxeoCdkStack } = require('../lib/nuxeo-aws-cdk-stack');

const app = new cdk.App();

// Values are passed on the command line, e.g.
// cdk deploy -c hostedZoneId=Z0123456789 -c zoneName=example.com [-c stackName=my-nuxeo]
const hostedZoneId = app.node.tryGetContext('hostedZoneId');
const zoneName = app.node.tryGetContext('zoneName');
const stackName = app.node.tryGetContext('stackName') || 'nuxeo-stack-cdk-try';

const missing = [];
if (!hostedZoneId) {
  missing.push('context value "hostedZoneId" (-c hostedZoneId=<value>)');
}
if (!zoneName) {
  missing.push('context value "zoneName" (-c zoneName=<value>)');
}
if (!process.env.NUXEO_CLID) {
  missing.push('NUXEO_CLID environment variable (export NUXEO_CLID=<MY_CLID>)');
}

if (missing.length > 0) {
  // Do not throw, so that commands which do not need the Nuxeo stack, like "cdk bootstrap", still work.
  // They fail on an app without any stack, hence the empty placeholder stack (with a distinct name, so it
  // can never replace a real one). Its error annotation makes "cdk synth/diff/deploy" stop with this message.
  const message = `The Nuxeo stack is not defined, missing:\n  - ${missing.join('\n  - ')}`;
  console.warn(`WARNING: ${message}`);
  const placeholder = new cdk.Stack(app, 'nuxeo-stack-not-configured');
  cdk.Annotations.of(placeholder).addError(message);
} else {
  const stack = new NuxeoCdkStack(app, stackName, {
    stackName: stackName,
    hostedZoneId: hostedZoneId,
    zoneName: zoneName,
    resourcePrefix: stackName
  });

  // tag nuxeo presales (to delete)
  cdk.Tags.of(stack).add('billing-category', 'generic');
  cdk.Tags.of(stack).add('billing-subcategory', 'trial');
}
