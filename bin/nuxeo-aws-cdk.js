#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { NuxeoCdkStack } = require('../lib/nuxeo-aws-cdk-stack');

const app = new cdk.App();

// Values are passed on the command line, e.g.
// cdk deploy -c hostedZoneId=Z0123456789 -c zoneName=example.com [-c stackName=my-nuxeo]
function requireContext(key) {
  const value = app.node.tryGetContext(key);
  if (!value) {
    throw new Error(`Missing context value "${key}". Pass it with: cdk <command> -c ${key}=<value>`);
  }
  return value;
}

if (!process.env.NUXEO_CLID) {
  throw new Error('NUXEO_CLID environment variable is not set. Run: export NUXEO_CLID=<MY_CLID>');
}

const stackName = app.node.tryGetContext('stackName') || 'nuxeo-stack-cdk-try';

const contextProps = {
  hostedZoneId: requireContext('hostedZoneId'),
  zoneName: requireContext('zoneName'),
  resourcePrefix: stackName
};

const stack = new NuxeoCdkStack(app, stackName, {
  stackName: stackName,
  ...contextProps
});

// tag nuxeo presales (to delete)
cdk.Tags.of(stack).add('billing-category', 'generic');
cdk.Tags.of(stack).add('billing-subcategory', 'trial');
