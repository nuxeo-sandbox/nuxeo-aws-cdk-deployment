#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { NuxeoCdkStack } = require('../lib/nuxeo-aws-cdk-stack');

const app = new cdk.App();

// Values are passed on the command line, e.g.
// cdk deploy -c hostedZoneId=Z0123456789 -c zoneName=example.com [-c stackName=my-nuxeo]
const hostedZoneId = app.node.tryGetContext('hostedZoneId');
const zoneName = app.node.tryGetContext('zoneName');
const stackName = app.node.tryGetContext('stackName') || 'nuxeo-stack-cdk-try';

const problems = [];
if (!hostedZoneId) {
  problems.push('missing context value "hostedZoneId" (-c hostedZoneId=<value>)');
}
if (!zoneName) {
  problems.push('missing context value "zoneName" (-c zoneName=<value>)');
}
if (!process.env.NUXEO_CLID) {
  problems.push('missing NUXEO_CLID environment variable (export NUXEO_CLID=<MY_CLID>)');
}

/*
 * The stack name is used as a prefix for the resource names, so it must satisfy the strictest of
 * their constraints: the OpenSearch domain (<stackName>-os) is limited to 28 characters, must start
 * with a lowercase letter and only accepts lowercase letters, digits and hyphens. Checking it here
 * avoids a failure an hour into the deployment.
 */
if (!/^[a-z][a-z0-9-]{0,24}$/.test(stackName)) {
  problems.push(
    `invalid "stackName": "${stackName}" must start with a lowercase letter, contain only lowercase` +
      ' letters, digits and hyphens, and be 25 characters long at most'
  );
}

if (problems.length > 0) {
  // Do not throw, so that commands which do not need the Nuxeo stack, like "cdk bootstrap", still work.
  // They fail on an app without any stack, hence the empty placeholder stack (with a distinct name, so it
  // can never replace a real one). Its error annotation makes "cdk synth/diff/deploy" stop with this message.
  const message = `The Nuxeo stack is not defined:\n  - ${problems.join('\n  - ')}`;
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
