# Nuxeo Deployment using AWS CDK

## Description
This CDK project deploys a complete Nuxeo application in a private VPC:
- An RDS Aurora PostgreSQL database cluster
- An OpenSearch cluster
- An MSk Kafka cluster
- An S3 bucket for binary files
- A Nuxeo cluster deployed in ECS
- An application loadbalancer configured with https
- A route 53 entry

# How to deploy
## Requirements
Building requires the following software:
- Git
- Node
- Docker
- AWS CLI

## Set your Nuxeo CLID as an environment variable
```bash
export NUXEO_CLID=<MY_CLID>
```

## Log into the Nuxeo private docker repository
Before building the image, you must first log into the Nuxeo private registry
```bash
docker login docker-private.packages.nuxeo.com -u <username> -p <token_pass_code>
```

## AWS CLI Sign In
In order to use AWS CDK, you must first Sign In with the AWS CLI 

```bash
aws sso login --profile <my-profile>
```

## AWS OpenSearch service role
In order to be able to create an Opensearch cluster, a service role must first be configured if not already done.

```bash
aws iam create-service-linked-role --aws-service-name opensearchservice.amazonaws.com --profile <my-profile>
```

## Checkout the code and install dependencies
```bash
https://github.com/nuxeo-sandbox/nuxeo-aws-cdk-deployment
cd nuxeo-aws-cdk-deployment
npm install
```

## Bootstrap CDK
Before the first deployement in an AWS account, you need to bootstrap the CDK resources

```bash
cdk bootstrap aws://ACCOUNT-NUMBER/REGION
```

The account number can simply be retreived with the following command

```bash
aws sts get-caller-identity --profile <my-profile>
```

## Deploy
Edit `bin/nuxeo-aws-cdk.js` to set the `contextProps` properties according to your environement

```bash
cdk deploy --profile <my-profile>
```

## Bastion Host
All the components (DB, Opensearch and Kafka) are deployed in a private subnet such that the respective APIs can only be accessed by other AWS services or through a bastion host.

The easiest way to open a terminal session is to use the [System Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-macos-overview.html#install-plugin-macos):

```bash
aws ssm start-session --target <instance-id> --profile <my-profile>
```

To get the instance id, use the AWS web console or the CLI

```bash
aws ec2 describe-instances --filters "Name=tag:cost:component,Values=nuxeo" --query "Reservations[].Instances[].InstanceId" --profile <my-profile>
```

## Run a Shell on a nuxeo container
The ECS cluster deployed as part of the stack is configured to enable container command execution

```bash
aws ecs execute-command --cluster <cluster-name> --task <task-id> --container <container-name> --command "/bin/bash" --interactive --profile <my-profile>
```

By default, the shell is opened as root. To change to the nuxeo user, run

```bash
su nuxeo
```

# License
[Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)

# About Nuxeo
Nuxeo Platform is an open source Content Services platform, written in Java. Data can be stored in both SQL & NoSQL databases.

The development of the Nuxeo Platform is mostly done by Nuxeo employees with an open development model.

The source code, documentation, roadmap, issue tracker, testing, benchmarks are all public.

Typically, Nuxeo users build different types of information management solutions for [document management](https://www.nuxeo.com/solutions/document-management/), [case management](https://www.nuxeo.com/solutions/case-management/), and [digital asset management](https://www.nuxeo.com/solutions/dam-digital-asset-management/), use cases. It uses schema-flexible metadata & content models that allows content to be repurposed to fulfill future use cases.

More information is available at [www.nuxeo.com](https://www.nuxeo.com)



