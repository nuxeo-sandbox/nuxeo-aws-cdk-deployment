#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { NuxeoCdkStack } = require('../lib/nuxeo-aws-cdk-stack');

const app = new cdk.App();

const stackName = 'nuxeo-stack-cdk-try';

const contextProps = {
  hostedZoneId: , 
  zoneName: ,
  resourcePrefix: stackName
} 

const stack = new NuxeoCdkStack(app, stackName, {
  stackName: stackName,
  ...contextProps
});

// tag nuxeo presales (to delete)
cdk.Tags.of(stack).add('billing-category', 'generic');
cdk.Tags.of(stack).add('billing-subcategory', 'trial');



