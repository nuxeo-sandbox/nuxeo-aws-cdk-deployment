# Nuxeo Deployment using AWS CDK

## Description
This CDK project deploys a complete Nuxeo application in a private VPC:
- An RDS Aurora PostgreSQL database cluster, behind an RDS Proxy
- An OpenSearch cluster
- An MSK Kafka cluster
- An S3 bucket for binary files
- A Nuxeo cluster deployed in ECS Fargate (one web service, one worker service)
- An application load balancer configured with HTTPS
- A Route 53 entry
- A bastion host, to access the private resources

## Versions

| Component | Version |
|---|---|
| Nuxeo | LTS 2025 (`2025.25`, see `docker/nuxeo/Dockerfile`) |
| Aurora PostgreSQL | 16 |
| Amazon MSK (Kafka) | 3.9.x, KRaft mode (requires Nuxeo 2025.5+) |
| Amazon OpenSearch Service | OpenSearch 1.3 |

The previous version, for Nuxeo LTS 2023 (Aurora PostgreSQL 13, Kafka 3.5.1), is available in the `lts2023` branch. It is no longer deployable as is: these engine versions are not supported by AWS anymore.

⚠️ **Costs**: the stack runs several billable services (Aurora, OpenSearch, MSK, Fargate, NAT gateway, load balancer...). Delete it when you are done, see [Delete the deployment](#delete-the-deployment).

# How to deploy

## Requirements
Software:
- Git
- Node 22.14 or later (for example `nvm install 22`, the repository contains a `.nvmrc`)
- Docker (with BuildKit, the default in recent versions). On Apple Silicon, the image is built for `linux/amd64` through emulation, which is slower.
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the AWS CLI, to connect to the bastion host and to the Nuxeo containers

You also need:
- An AWS account, with administrator permissions
- A **public** Route 53 hosted zone in this AWS account (for example `example.com`). Nuxeo will be available at `https://<stackName>.<zoneName>/nuxeo`, with a certificate validated through this zone.
- A Nuxeo CLID, and credentials for the Nuxeo private Docker registry (`docker-private.packages.nuxeo.com`)

## Checkout the code and install dependencies
```bash
git clone https://github.com/nuxeo-sandbox/nuxeo-aws-cdk-deployment
cd nuxeo-aws-cdk-deployment
nvm use
npm ci
```

All the following commands are run from this directory.

## Sign in to AWS and choose the region
Sign in with the AWS CLI (SSO in this example), then export the profile and the region to use, so that all the `aws` and `cdk` commands below use them:

```bash
aws sso login --profile <my-profile>
export AWS_PROFILE=<my-profile>
export AWS_REGION=<region>
```

Get your account number, needed to bootstrap CDK:

```bash
aws sts get-caller-identity --query Account --output text
```

## Set the deployment parameters
```bash
export STACK_NAME=<stack-name>
export HOSTED_ZONE_ID=<hosted-zone-id>
export ZONE_NAME=<zone-name>
export NUXEO_CLID=<MY_CLID>
```

- `STACK_NAME`: lowercase letters, digits and hyphens only, 25 characters maximum (it is used to name the resources, e.g. the S3 bucket and the OpenSearch domain). It must not already be used in the account.
- `HOSTED_ZONE_ID` and `ZONE_NAME`: your public hosted zone. To list them (use the ID without the `/hostedzone/` prefix, and the name without the trailing dot):

  ```bash
  aws route53 list-hosted-zones --query "HostedZones[?Config.PrivateZone==\`false\`].[Id,Name]" --output text
  ```

- `NUXEO_CLID`: if your CLID is on two lines, join them with `--` (`<first line>--<second line>`). It is passed as a Docker build secret to install the Nuxeo packages, so it is not stored in the image. The stack also stores it in AWS Secrets Manager, to register the instance when Nuxeo starts (note that the value is then also in the synthesized CloudFormation template; to avoid it, create the secret beforehand and import it with `Secret.fromSecretNameV2` in `lib/nuxeo-aws-cdk-stack.js`).

## Log into the Nuxeo private Docker registry
The Nuxeo image is built locally during the deployment. Enter your registry token when prompted:

```bash
docker login docker-private.packages.nuxeo.com -u <username>
```

## AWS OpenSearch service role
OpenSearch requires a service-linked role in the account. Create it, if not already done:

```bash
aws iam create-service-linked-role --aws-service-name opensearchservice.amazonaws.com
```

If you get the error `Service role name AWSServiceRoleForAmazonOpenSearchService has been taken in this account`, the role already exists: there is nothing to do.

## Bootstrap CDK
CDK needs some resources (S3 bucket, ECR repository, IAM roles) in each account and region where it deploys. Bootstrap them, or upgrade an existing bootstrap:

```bash
npx cdk bootstrap aws://<ACCOUNT-NUMBER>/$AWS_REGION
```

If this fails, see [Troubleshooting](#troubleshooting).

## Deploy
Check that the database instance class (`db.t4g.medium`) is available for Aurora PostgreSQL 16 in your region (the command must list availability zones):

```bash
aws rds describe-orderable-db-instance-options --engine aurora-postgresql --engine-version 16.13 --db-instance-class db.t4g.medium --query "OrderableDBInstanceOptions[].AvailabilityZones[].Name" --output text
```

Optionally, review the resources that will be created:

```bash
npx cdk diff -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

Deploy. CDK asks you to confirm the IAM and security group changes (answer `y`). The deployment takes about one hour, mostly for the Kafka and OpenSearch clusters:

```bash
npx cdk deploy -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

If a parameter is missing, CDK reports `The Nuxeo stack is not defined, missing: ...` and nothing is deployed.

## Access Nuxeo
At the end of the deployment, CDK displays the stack outputs, among them the `ServiceURL` and the `BastionHostId`. You can display them again with:

```bash
aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
```

Nuxeo is available at `https://<stackName>.<zoneName>/nuxeo`. Log in with the default `Administrator`/`Administrator` credentials and ⚠️ **change this password right away**: the application is publicly accessible.

## Bastion Host
All the components (DB, OpenSearch and Kafka) are deployed in private subnets, so that their APIs can only be accessed by other AWS services or through the bastion host.

To open a terminal session on the bastion host with Session Manager:

```bash
BASTION_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?contains(OutputKey,'BastionHostId')].OutputValue" --output text)
aws ssm start-session --target $BASTION_ID
```

### PSQL
Get the RDS proxy endpoint, and the password of the `nuxeo` database user (`password` field of the secret):

```bash
PROXY_NAME=$(aws cloudformation describe-stack-resources --stack-name $STACK_NAME --query "StackResources[?ResourceType=='AWS::RDS::DBProxy'].PhysicalResourceId" --output text)
aws rds describe-db-proxies --db-proxy-name $PROXY_NAME --query "DBProxies[0].Endpoint" --output text
aws secretsmanager get-secret-value --secret-id $STACK_NAME-db-secret --query SecretString --output text
```

Then, in the bastion host session, install the psql command line and connect:

```bash
sudo dnf install -y postgresql16
psql -h <rds-proxy-endpoint> -U nuxeo -d nuxeo
```

### Tunnel
With Session Manager, it is also possible to open a tunnel through the bastion host. For example, a tunnel to the DB can be set up in order to use desktop tools like pgAdmin, connecting to `localhost:5432`:

```bash
aws ssm start-session --target $BASTION_ID --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"host":["<rds-proxy-endpoint>"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```

## Run a Shell on a Nuxeo container
The ECS cluster deployed as part of the stack is configured to enable container command execution. For a web container:

```bash
TASK_ID=$(aws ecs list-tasks --cluster $STACK_NAME-ecs-cluster --service-name $STACK_NAME-ecs-web-service --query "taskArns[0]" --output text)
aws ecs execute-command --cluster $STACK_NAME-ecs-cluster --task $TASK_ID --container $STACK_NAME-ecs-web-container --command "/bin/bash" --interactive
```

For a worker container, use the `$STACK_NAME-ecs-worker-service` service and the `$STACK_NAME-ecs-worker-task-container` container.

By default, the shell is opened as root. To change to the nuxeo user, run

```bash
su nuxeo
```

# Delete the deployment
Delete the stack, with the same parameters as for the deployment (CDK asks for confirmation):

```bash
npx cdk destroy -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

Most resources are deleted with the stack, including the S3 bucket and its content. A few are kept on purpose, delete them manually if you do not need them:
- The final snapshot of the Aurora database:

  ```bash
  aws rds describe-db-cluster-snapshots --snapshot-type manual --query "DBClusterSnapshots[?DBClusterIdentifier=='$STACK_NAME-db-cluster'].DBClusterSnapshotIdentifier" --output text
  aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier <snapshot-id>
  ```

- The CloudWatch log groups (Nuxeo containers, Lambda functions, Container Insights):

  ```bash
  aws logs describe-log-groups --log-group-name-pattern $STACK_NAME --query "logGroups[].logGroupName" --output text
  aws logs delete-log-group --log-group-name <log-group-name>
  ```

- The DNS records created in the hosted zone to validate the certificate may remain. They are harmless and reused if you deploy again.

The CDK bootstrap resources are shared by all the CDK applications deployed in the account and region: keep them.

# Troubleshooting

## Bootstrap fails: a resource "does not exist"
For example `The repository with name 'cdk-hnb659fds-container-assets-<account>-<region>' does not exist`: the account was bootstrapped before, but some of the bootstrap resources (ECR repository, S3 bucket) were deleted outside of CloudFormation, so the default bootstrap cannot be used anymore. Ask the account administrators to fix it, or bootstrap dedicated resources for this deployment, with their own qualifier (10 lowercase letters or digits maximum) and stack name:

```bash
export CDK_QUALIFIER=<qualifier>
npx cdk bootstrap aws://<ACCOUNT-NUMBER>/$AWS_REGION --qualifier $CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER
```

Then add `-c @aws-cdk/core:bootstrapQualifier=$CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER` to **all** the `cdk diff`, `cdk deploy` and `cdk destroy` commands, for example:

```bash
npx cdk deploy -c @aws-cdk/core:bootstrapQualifier=$CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

These bootstrap resources are only used by this deployment. To remove them, **after** deleting the Nuxeo stack:

```bash
aws ecr delete-repository --repository-name cdk-$CDK_QUALIFIER-container-assets-<ACCOUNT-NUMBER>-$AWS_REGION --force
aws cloudformation delete-stack --stack-name CDKToolkit-$CDK_QUALIFIER
```

Then empty and delete the `cdk-<qualifier>-assets-<ACCOUNT-NUMBER>-<region>` S3 bucket, which is kept by CloudFormation (the bucket is versioned: use the **Empty** button of the S3 console, which also deletes the previous versions).

## Deploy fails: a secret "is already scheduled for deletion"
When deploying again with the same stack name shortly after deleting it, the previous secrets may still be pending deletion. Delete them immediately (`<STACK_NAME>-clid` and `<STACK_NAME>-db-secret`), then deploy again:

```bash
aws secretsmanager delete-secret --secret-id <secret-name> --force-delete-without-recovery
```

# License
[Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)

# About Nuxeo
Nuxeo Platform is an open source Content Services platform, written in Java. Data can be stored in both SQL & NoSQL databases.

The development of the Nuxeo Platform is mostly done by Nuxeo employees with an open development model.

The source code, documentation, roadmap, issue tracker, testing, benchmarks are all public.

Typically, Nuxeo users build different types of information management solutions for [document management](https://www.nuxeo.com/solutions/document-management/), [case management](https://www.nuxeo.com/solutions/case-management/), and [digital asset management](https://www.nuxeo.com/solutions/dam-digital-asset-management/), use cases. It uses schema-flexible metadata & content models that allows content to be repurposed to fulfill future use cases.

More information is available at [www.nuxeo.com](https://www.nuxeo.com)
