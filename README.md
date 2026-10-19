# Nuxeo Deployment using AWS CDK

> [!CAUTION]
> This repository is an **example deployment**, not a production-ready setup.
> - **No Nuxeo Studio project is installed**: you get a vanilla Nuxeo. See
>   [Install a Nuxeo Studio project](#install-a-nuxeo-studio-project) to add yours.
> - Nuxeo is **publicly reachable on the internet** and starts with the default
>   `Administrator` / `Administrator` credentials: **change the password as soon as the
>   stack is deployed**.
> - The stack is **billable** and is not covered by the free tier: see [Costs](#costs)
>   and [Delete the deployment](#delete-the-deployment).
> - **Autoscaling is an example and needs tuning** (fopr example, add sticky sessions
    to the loadbalancer)

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

The stack does not pin an AWS account or region, so CDK deploys it over **two availability zones**.
With the sizing of this repository, that means: 2 OpenSearch data nodes (`m7g.large.search`, no
dedicated master node), 2 MSK brokers (`kafka.m5.large`, 100 GiB each), a single Aurora writer
(`db.t4g.medium`, no reader: Nuxeo always goes through the RDS proxy to the writer, so a reader
would serve no traffic), one NAT gateway, one web Fargate task (2 vCPU / 4 GiB / 30 GiB of
ephemeral storage) and one worker Fargate task (4 vCPU / 8 GiB / 60 GiB, it runs the video and
image conversions), both able to scale out to 2.

## Versions

| Component | Version |
|---|---|
| Nuxeo | LTS 2025 (`2025.25`, see `docker/nuxeo/Dockerfile`) |
| Aurora PostgreSQL | 16 |
| Amazon MSK (Kafka) | 3.9.x, KRaft mode |
| Amazon OpenSearch Service | OpenSearch 1.3 |

The previous version, for Nuxeo LTS 2023 (Aurora PostgreSQL 13, Kafka 3.5.1), is available in the `lts2023` branch. It is no longer deployable as is: these engine versions are not supported by AWS anymore.

## Costs

> [!WARNING]
> The stack runs several billable services. With the sizing of this repository, expect roughly
> **$1,000 to $1,500 per month** if you leave it running (OpenSearch and MSK are the two largest
> items, then Fargate, Aurora, the RDS proxy, the NAT gateway and the load balancer). Delete it
> when you are done, see [Delete the deployment](#delete-the-deployment).

# How to deploy

## Requirements
Software:
- Git
- Node 22.14 or later (for example `nvm install 22`, the repository contains a `.nvmrc`)
- Docker (with BuildKit, the default in recent versions). On Apple Silicon, the image is built for `linux/amd64` through emulation: Docker Desktop uses Rosetta, so it stays reasonably fast.
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
nvm use 22 ## or greater
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

If your **default** profile is already the one you want to use, `--profile` and `export AWS_PROFILE` are not needed, `aws sso login` is enough. `AWS_REGION`, on the other hand, is always needed: the `cdk bootstrap` command below builds the target environment from it.

Sign in right before deploying: the deployment takes more than an hour, and an expired session interrupts it. If that happens, the stack keeps being created by CloudFormation, only the command that follows it stops: sign in again and run `npx cdk deploy` with the same parameters to pick it up.

Get your account number, needed to bootstrap CDK:

```bash
aws sts get-caller-identity --query Account --output text
```

## Set the deployment parameters
All four values are required, the deployment stops right away if one of them is missing.

```bash
export STACK_NAME=<stack-name>
export HOSTED_ZONE_ID=<hosted-zone-id>
export ZONE_NAME=<zone-name>
export NUXEO_CLID=<MY_CLID>
```

- `STACK_NAME`: it must start with a lowercase letter, contain only lowercase letters, digits and hyphens, and be 25 characters long at most. It is used to name the resources, so it must not already be used in the account, and the S3 bucket it generates (`<stackName>-bucket`) must not already exist **in any AWS account**, since S3 bucket names are globally unique. The name is checked before anything is deployed. Nuxeo is published at `https://<stackName>.<zoneName>`, so pick a name that is not already a record of your hosted zone.
- `HOSTED_ZONE_ID` and `ZONE_NAME`: your public hosted zone. To list them (use the ID without the `/hostedzone/` prefix, and the name without the trailing dot):

  ```bash
  aws route53 list-hosted-zones --query "HostedZones[?Config.PrivateZone==\`false\`].[Id,Name]" --output text
  ```

- `NUXEO_CLID`: the content of your `instance.clid` file, with its two lines joined by `--` (`<first line>--<second line>`). Some CLID files have a third line: it is the instance description, it is optional and you can leave it out. To build the value from the file:

  ```bash
  export NUXEO_CLID="$(awk 'NR==1{a=$0} NR==2{b=$0} END{print a"--"b}' /path/to/instance.clid)"
  ```

  It is passed as a Docker build secret to install the Nuxeo packages, so it is not stored in the image. The stack also stores it in AWS Secrets Manager, to register the instance when Nuxeo starts (note that the value is then also in the synthesized CloudFormation template, and so in the CDK assets bucket and in the CloudFormation console; to avoid it, create the secret beforehand and import it with `Secret.fromSecretNameV2` in `lib/nuxeo-aws-cdk-stack.js`).

## Install a Nuxeo Studio project
By default the image only contains `nuxeo-web-ui`, the S3 storage package and the OpenSearch packages: the deployed application is a **vanilla Nuxeo**, without any Studio customization.

To deploy your own Studio project, add its package name to the list passed to `install-packages.sh` in `docker/nuxeo/Dockerfile`:

```dockerfile
RUN --mount=type=secret,id=clid,uid=900 \
    /install-packages.sh --clid "$(cat /run/secrets/clid)" \
      nuxeo-web-ui \
      amazon-s3-online-storage \
      nuxeo-search-client-opensearch1 \
      nuxeo-audit-opensearch1 \
      nuxeo-uidgen-opensearch1 \
      my-studio-project-1.0.0
```

The package name is the one shown in Studio, under *Settings* > *Application Definition*, usually `<project-id>-<version>`. The CLID used as a build secret is what authorizes the download, so no extra credential is needed, and the project must have been published to the Nuxeo Marketplace beforehand.

Editing the `Dockerfile` changes the asset hash of the image, so the next `npx cdk deploy` rebuilds it and rolls out the new version on both services.

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

Deploy. CDK asks you to confirm the IAM and security group changes (answer `y`):

```bash
npx cdk deploy -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

Count **90 minutes to two hours**. The Nuxeo image is built and pushed to ECR first, then most of the time is spent on the Kafka cluster and, at the very end, on the first start of Nuxeo. On Apple Silicon the build is the longest step by far: the image is built for `linux/amd64` through emulation, and the few GB of the result still have to be uploaded to ECR.

If a parameter is missing or invalid, CDK reports `The Nuxeo stack is not defined: ...` and nothing is deployed.

CDK prints a `WARNING Tags: Additional properties are not allowed ('Tags' was unexpected)` on the RDS proxy target group. It is a false alarm, coming from a schema bundled with the CDK CLI that is older than the CloudFormation registry: `AWS::RDS::DBProxyTargetGroup` does support `Tags`, and the deployment is not affected.

## Access Nuxeo
At the end of the deployment, CDK displays the stack outputs, among them the `ServiceURL` and the `BastionHostId`. You can display them again with:

```bash
aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
```

Nuxeo is available at `https://<stackName>.<zoneName>/nuxeo`.

> [!IMPORTANT]
> Log in with the default `Administrator` / `Administrator` credentials, then change this password
> immediately: the load balancer accepts traffic from anywhere on the internet.

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

If `postgresql16` is not found, the Amazon Linux 2023 repositories of your region may ship another version: `dnf search postgresql` lists the available ones, any recent client works.

The bastion host is a `t3.nano`, so `dnf install` takes several minutes: this is expected.

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
Delete the stack, with the same parameters as for the deployment (CDK asks for confirmation). `NUXEO_CLID` must still be exported: without it the stack is not defined and CDK does not find it, so set the variables again if you are in a new terminal:

```bash
npx cdk destroy -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

Count 30 to 60 minutes, most of it on the OpenSearch domain, the Kafka cluster and the VPC. The deletion sometimes fails at the very end on the VPC, the subnets or a security group, with a `has dependencies and cannot be deleted` error: the network interfaces of the Lambda functions deployed in the VPC are still being detached. Wait a few minutes and run the same `npx cdk destroy` command again, it picks up where it stopped.

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

  The log group of the RDS proxy is **not** returned by the command above, because its name is derived from the stack name without the hyphens. List and delete it separately:

  ```bash
  aws logs describe-log-groups --log-group-name-prefix /aws/rds/proxy --query "logGroups[].logGroupName" --output text
  aws logs delete-log-group --log-group-name <log-group-name>
  ```

- The Nuxeo image, in the ECR repository of the CDK bootstrap. It is several GB, it is billed every month and nothing removes it, so this is the most expensive leftover of a deleted stack. The repository is shared with the other CDK applications of the account: delete the image, not the repository. The tag to delete is the one used by the `Image` of the task definitions of the stack you just deleted, and `aws ecr describe-images` sorted by date makes it easy to spot:

  ```bash
  REPO=cdk-hnb659fds-container-assets-<ACCOUNT-NUMBER>-$AWS_REGION
  aws ecr describe-images --repository-name $REPO --query "sort_by(imageDetails,&imagePushedAt)[].[imagePushedAt,imageSizeInBytes,imageTags[0]]" --output table
  aws ecr batch-delete-image --repository-name $REPO --image-ids imageTag=<tag>
  ```

- The DNS records created in the hosted zone to validate the certificate may remain. They are harmless and reused if you deploy again.

The CDK bootstrap resources themselves (the `CDKToolkit` stack, its S3 bucket and its ECR repository) are shared by all the CDK applications deployed in the account and region: keep them.

## Check that nothing is left
```bash
# the stack itself
aws cloudformation describe-stacks --stack-name $STACK_NAME
# the Aurora final snapshot
aws rds describe-db-cluster-snapshots --snapshot-type manual --query "DBClusterSnapshots[?DBClusterIdentifier=='$STACK_NAME-db-cluster'].DBClusterSnapshotIdentifier" --output text
# the log groups, including the RDS proxy one
aws logs describe-log-groups --log-group-name-pattern $STACK_NAME --query "logGroups[].logGroupName" --output text
aws logs describe-log-groups --log-group-name-prefix /aws/rds/proxy --query "logGroups[].logGroupName" --output text
# the Nuxeo image in the bootstrap ECR repository
aws ecr describe-images --repository-name cdk-hnb659fds-container-assets-<ACCOUNT-NUMBER>-$AWS_REGION --query "sort_by(imageDetails,&imagePushedAt)[].[imagePushedAt,imageSizeInBytes,imageTags[0]]" --output table
# the secrets, which must not be left pending deletion
aws secretsmanager list-secrets --include-planned-deletion --query "SecretList[?starts_with(Name,'$STACK_NAME')].[Name,DeletedDate]" --output text
```

The first command must report `Stack with id <stack-name> does not exist` and the others must return nothing.

# Troubleshooting

## Bootstrap fails: a resource "does not exist"
For example `The repository with name 'cdk-hnb659fds-container-assets-<account>-<region>' does not exist`: the account was bootstrapped before, but some of the bootstrap resources (ECR repository, S3 bucket) were deleted outside of CloudFormation, so the default bootstrap cannot be used anymore. Ask the account administrators to fix it, or bootstrap dedicated resources for this deployment, with their own qualifier (10 lowercase letters or digits maximum) and stack name:

```bash
export CDK_QUALIFIER=<qualifier>
npx cdk bootstrap aws://<ACCOUNT-NUMBER>/$AWS_REGION --qualifier $CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER
```

The CDK CLI prints `Unknown option(s): --q. These will be ignored.` on this command. It is a false alarm: `--qualifier` is a valid option and it is applied, check the `BucketName` and `ImageRepositoryName` outputs of the `CDKToolkit-<qualifier>` stack.

Then add `-c @aws-cdk/core:bootstrapQualifier=$CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER` to **all** the `cdk diff`, `cdk deploy` and `cdk destroy` commands, for example:

```bash
npx cdk deploy -c @aws-cdk/core:bootstrapQualifier=$CDK_QUALIFIER --toolkit-stack-name CDKToolkit-$CDK_QUALIFIER -c stackName=$STACK_NAME -c hostedZoneId=$HOSTED_ZONE_ID -c zoneName=$ZONE_NAME
```

These bootstrap resources are only used by this deployment. To remove them, **after** deleting the Nuxeo stack:

```bash
aws ecr delete-repository --repository-name cdk-$CDK_QUALIFIER-container-assets-<ACCOUNT-NUMBER>-$AWS_REGION --force
aws cloudformation delete-stack --stack-name CDKToolkit-$CDK_QUALIFIER
```

The `cdk-$CDK_QUALIFIER-assets-<ACCOUNT-NUMBER>-$AWS_REGION` S3 bucket is kept by CloudFormation. It is versioned, so every version has to be deleted before the bucket itself:

```bash
BUCKET=cdk-$CDK_QUALIFIER-assets-<ACCOUNT-NUMBER>-$AWS_REGION
aws s3api delete-objects --bucket $BUCKET \
  --delete "$(aws s3api list-object-versions --bucket $BUCKET --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"
aws s3api delete-bucket --bucket $BUCKET
```

If `delete-bucket` reports that the bucket is not empty, it also contains delete markers: run the same `delete-objects` command with `DeleteMarkers[]` instead of `Versions[]`, then delete the bucket again.

## Deploy fails: a secret "is already scheduled for deletion"
The secrets of the stack (`<STACK_NAME>-clid` and `<STACK_NAME>-db-secret`) are normally deleted with it. Should they be kept pending deletion instead, deploying again with the same stack name fails: delete them immediately, then deploy again:

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
