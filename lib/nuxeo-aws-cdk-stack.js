const path = require('node:path'); 
const {
  Stack,
  Duration,
  RemovalPolicy,
  SecretValue,
  Tags,
} = require("aws-cdk-lib");
const { DockerImageAsset } = require("aws-cdk-lib/aws-ecr-assets");
const s3 = require("aws-cdk-lib/aws-s3");
const ec2 = require("aws-cdk-lib/aws-ec2");
const rds = require("aws-cdk-lib/aws-rds");
const iam = require("aws-cdk-lib/aws-iam");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecsPatterns = require("aws-cdk-lib/aws-ecs-patterns");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const msk = require("@aws-cdk/aws-msk-alpha");
const { Domain, EngineVersion } = require("aws-cdk-lib/aws-opensearchservice");
const { HostedZone } = require("aws-cdk-lib/aws-route53");
const {
  Certificate,
  CertificateValidation,
} = require("aws-cdk-lib/aws-certificatemanager");
const sql = require("cdk-rds-sql");

class NuxeoCdkStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    const prefix = props.resourcePrefix;

    //build nuxeo image
    const nuxeoDockerAsset = new DockerImageAsset(this, `${prefix}-nuxeo-app-container-image`, {
      directory: path.join(__dirname, '../docker/nuxeo'),
      assetName: 'nuxeo-app',
      buildArgs: {
        NUXEO_CLID: process.env.NUXEO_CLID,
      },
      invalidation: {
        buildArgs: false,
      },
    });

    //Set up a VPC
    const vpc = new ec2.Vpc(this, `${prefix}-vpc`, {
      vpcName: `${prefix}-vpc`,
      natGateways: 1,
      enableDnsSupport: true,
      enableDnsHostnames: true,
    });

    //Create a bastion host
    const bastionHost = new ec2.BastionHostLinux(this, `${prefix}-bastion`, {
      vpc,
      SubnetSelection: ec2.SubnetType.PUBLIC,
      instanceName: `${prefix}-bastion`,
      blockDevices: [
        {
          deviceName: "/dev/sdh",
          volume: ec2.BlockDeviceVolume.ebs(10, {
            encrypted: true,
          }),
        },
      ],
    });

    //Create an S3 Bucket
    const corsRule = {
      allowedMethods: [s3.HttpMethods.HEAD, s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
      allowedOrigins: [`https://${prefix}.${props.zoneName}`],
      allowedHeaders: ['*'],
      exposedHeaders: ["ETag", "Content-Disposition"],
      id: 'direct-download-upload-rule',
      maxAge: 60,
    };
    
    const bucket = new s3.Bucket(this, `${prefix}-bucket`, {
      bucketName: `${prefix}-bucket`,
      versioned: true,
      transferAcceleration: true,
      removalPolicy: RemovalPolicy.DESTROY,
      cors: [corsRule]
    });

    //Create DB
    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      `${prefix}-db-security-group`,
      {
        vpc: vpc,
        allowAllOutbound: true,
        securityGroupName: `${prefix}-db-security-group`,
        description: "Security Group For the RDS Cluster",
      }
    );

    dbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      "allow DB traffic from anywhere"
    );

    const db = new rds.DatabaseCluster(this, `${prefix}-db-cluster`, {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_13_13,
      }),
      clusterIdentifier: `${prefix}-db-cluster`,
      writer: rds.ClusterInstance.provisioned("writer", {
        publiclyAccessible: false,
      }),
      readers: [rds.ClusterInstance.provisioned("reader")],
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [dbSecurityGroup],
    });

    //init db
    const dbProvider = new sql.Provider(this, `${prefix}-db-init-provider`, {
      vpc: vpc,
      cluster: db,
      secret: db.secret,
    });

    const dbSqlRole = new sql.Role(this, `${prefix}-db-init-role`, {
      provider: dbProvider,
      roleName: "nuxeo",
      databaseName: "nuxeo",
      secretName: `${prefix}-db-secret`,
    });

    const dbSqlDatabase = new sql.Database(this, `${prefix}-db-init-database`, {
      provider: dbProvider,
      databaseName: "nuxeo",
      owner: dbSqlRole,
    })

    //create RDS Proxy
    const dbProxy = new rds.DatabaseProxy(this, `${prefix}-db-proxy`, {
      proxyTarget: rds.ProxyTarget.fromCluster(db),
      secrets: [db.secret, dbSqlRole.secret],
      vpc,
      securityGroups: [dbSecurityGroup],
    });

    //Create opensearch cluster
    //security group
    const opensearchSG = new ec2.SecurityGroup(
      this,
      `${prefix}-opensearch-security-group`,
      {
        vpc,
        allowAllOutbound: true,
        securityGroupName: `${prefix}-opensearch-security-group`,
        description: "Security group for the opensearch cluster",
      }
    );

    opensearchSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "allow HTTPS traffic from anywhere"
    );

    const opensearchDomain = new Domain(this, `${prefix}-os`, {
      version: EngineVersion.OPENSEARCH_1_3,
      enableVersionUpgrade: true,
      removalPolicy: RemovalPolicy.DESTROY,
      vpc,
      vpcSubnets: [{ subnets: vpc.privateSubnets }],
      securityGroups: [opensearchSG],
      zoneAwareness: {
        enabled: true,
        availabilityZoneCount: 2,
      },
      capacity: {
        multiAzWithStandbyEnabled: false,
        masterNodes: 3,
        dataNodes: 2,
      },
      enforceHttps: true,
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true,
      },
      domainName: `${prefix}-os`,
    });

    const opensearchAccessPolicy = new iam.PolicyStatement({
      actions: [
        "es:ESHttpHead",
        "es:ESHttpGet",
        "es:ESHttpPut",
        "es:ESHttpPost",
        "es:ESHttpDelete",
      ],
      resources: [opensearchDomain.domainArn + "/*"],
      principals: [new iam.AnyPrincipal()],
      effect: iam.Effect.ALLOW,
    });

    opensearchDomain.addAccessPolicies(opensearchAccessPolicy);

    // Create a MSK Kafka cluster
    //security group
    const mskSG = new ec2.SecurityGroup(this, `${prefix}-msk-security-group`, {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `${prefix}-msk-security-group`,
      description: "security group for the msk cluster",
    });

    mskSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(9092),
      "allow Kafka access from anywhere"
    );

    const mskKafkaCluster = new msk.Cluster(this, `${prefix}-msk-cluster`, {
      clusterName: `${prefix}-msk-cluster`,
      kafkaVersion: msk.KafkaVersion.V3_5_1,
      vpc,
      securityGroups: [mskSG],
      encryptionInTransit: {
        clientBroker: msk.ClientBrokerEncryption.PLAINTEXT,
      },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, `${prefix}-ecs-cluster`, {
      clusterName: `${prefix}-ecs-cluster`,
      containerInsights: true,
      vpc: vpc,
    });

    // create task container role
    const sharedResourcesPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ["arn:aws:s3:::*"],
          actions: ["s3:ListAllMyBuckets"],
          effect: iam.Effect.ALLOW,
        }),
        new iam.PolicyStatement({
          resources: ["*"],
          actions: [
            "textract:*",
            "comprehend:*",
            "rekognition:DetectLabels",
            "rekognition:DetectText",
            "rekognition:RecognizeCelebrities",
            "rekognition:GetCelebrityInfo",
            "rekognition:DetectModerationLabels",
            "rekognition:DetectFaces",
            "transcribe:*",
            "translate:TranslateText",
            "rekognition:StartLabelDetection",
            "rekognition:GetLabelDetection",
            "rekognition:StartCelebrityRecognition",
            "rekognition:GetCelebrityRecognition",
            "rekognition:StartContentModeration",
            "rekognition:GetContentModeration",
            "rekognition:StartFaceDetection",
            "rekognition:GetFaceDetection",
            "rekognition:StartTextDetection",
            "rekognition:GetTextDetection",
            "rekognition:StartSegmentDetection",
            "rekognition:GetSegmentDetection",
          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const s3ResourcesPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ["arn:aws:s3:::*"],
          actions: ["s3:ListAllMyBuckets"],
          effect: iam.Effect.ALLOW,
        }),
        new iam.PolicyStatement({
          resources: [bucket.bucketArn],
          actions: [
            "s3:ListBucket",
            "s3:GetBucketLocation",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
            "s3:ListBucketMultipartUploads",
            "s3:GetBucketObjectLockConfiguration",
            "s3:GetBucketVersioning",
          ],
          effect: iam.Effect.ALLOW,
        }),
        new iam.PolicyStatement({
          resources: [bucket.bucketArn + "/*"],
          actions: [
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject",
            "s3:AbortMultipartUpload",
            "s3:ListMultipartUploadParts",
            "s3:ListBucketMultipartUploads",
            "s3:PutObjectRetention",
            "s3:PutObjectLegalHold",
          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const taskRole = new iam.Role(this, `${prefix}-ecs-task-role`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: `${prefix}-ecs-task-role`,
      description: "Nuxeo ECS Tasks Instance Role",
      inlinePolicies: {
        SharedResourcesPolicy: sharedResourcesPolicy,
        S3ResourcesPolicy: s3ResourcesPolicy,
      },
    });

    // direct upload role
    const directUploadRole = new iam.Role(this, `${prefix}-ecs-task-direct-upload-role`, {
      assumedBy:  taskRole,
      roleName: `${prefix}-ecs-task-direct-upload-role`,
      description: "Nuxeo Container Tasks Instance Direct Upload Role",
      inlinePolicies: {
        uploadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              resources: [bucket.bucketArn+"/upload/*"],
              actions: ["s3:PutObject"],
              effect: iam.Effect.ALLOW,
            })
          ],
        })
      }
    });

    Tags.of(taskRole).add("security:role-type", "service");
    Tags.of(taskRole).add("security:authorization", "single");

    //create container env variables
    const containerEnv = {
      S3_BUCKET: bucket.bucketName,
      S3_UPLOAD_ROLE_ARN : directUploadRole.roleArn,
      OPENSEARCH_ENDPOINT: opensearchDomain.domainEndpoint,
      MSK_ENDPOINT: mskKafkaCluster.bootstrapBrokers,
      DB_ENDPOINT: dbProxy.endpoint,
    };

    //create container secrets
    const nuxeoClidSecret = new secretsmanager.Secret(this,`${prefix}-clid`, {
      secretName:`${prefix}-clid`,
      secretObjectValue: {
        clid: SecretValue.unsafePlainText(process.env.NUXEO_CLID),
      }
    });

    const containerSecrets =  {
      NUXEO_CLID: ecs.Secret.fromSecretsManager(nuxeoClidSecret, "clid"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSqlRole.secret, "password"),
    };


    //Create frontend node task
    const webTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      `${prefix}-ecs-web-task`,
      {
        family: `${prefix}-ecs-web-task`,
        memoryLimitMiB: 4096,
        cpu: 2048,
        taskRole: taskRole,
      }
    );

    webTaskDefinition.addContainer(`${prefix}-ecs-web-container`, {
      image: ecs.ContainerImage.fromEcrRepository(
        nuxeoDockerAsset.repository,
        nuxeoDockerAsset.imageTag
      ),
      portMappings: [
        {
          hostPort: 8080,
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${prefix}-ecs-web-task-log-group`,
        logRetention: 30,
      }),
      environment: {
        'DISABLE_PROCESSING':"true",
        ...containerEnv
      },
      secrets: containerSecrets
    });

    //create ALB

    const demoZone = HostedZone.fromHostedZoneAttributes(
      this,
      `${prefix}-cloud-nuxeo-zone`,
      { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName }
    );

    const httpsCertificate = new Certificate(this, `${prefix}-alb-https-cert`, {
      domainName: props.zoneName,
      subjectAlternativeNames: [`${prefix}.${props.zoneName}`],
      validation: CertificateValidation.fromDns(demoZone),
    });

    const albSg = new ec2.SecurityGroup(this, `${prefix}-alb-security-group`, {
      vpc,
      allowAllOutbound: true,
      description: "Security group for a alb",
    });

    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "allow HTTP traffic from anywhere"
    );

    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "allow HTTPS traffic from anywhere"
    );

    const publicAlb = new elbv2.ApplicationLoadBalancer(
      this,
      `${prefix}-public-alb`,
      {
        internetFacing: true,
        vpc,
        vpcSubnets: {
          subnets: vpc.publicSubnets,
        },
        securityGroup: albSg,
      }
    );

    Tags.of(publicAlb).add("Exposure", "PUBLIC-EXPOSITION");

    const nuxeoWebService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        `${prefix}-ecs-web-service`,
        {
          serviceName: `${prefix}-ecs-web-service`,
          cluster,
          taskDefinition: webTaskDefinition,
          loadBalancer: publicAlb,
          domainName: `${prefix}.${props.zoneName}`,
          domainZone: demoZone,
          certificate: httpsCertificate,
          healthCheckGracePeriod: Duration.seconds(120),
        }
      );

    //Create Auto Scaling Policy
    nuxeoWebService.service
      .autoScaleTaskCount({ maxCapacity: 2 })
      .scaleOnCpuUtilization(`${prefix}-ecs-web-service-auto-scalling`, {
        targetUtilizationPercent: 50,
        scaleInCooldown: Duration.seconds(60),
        scaleOutCooldown: Duration.seconds(60),
      });

    // Create worker node tasks

    const workertaskDefinition = new ecs.FargateTaskDefinition(
      this,
      `${prefix}-ecs-worker-task`,
      {
        family: `${prefix}-ecs-worker-task`,
        memoryLimitMiB: 8192,
        cpu: 4096,
        taskRole: taskRole,
      }
    );


    workertaskDefinition.addContainer(`${prefix}-ecs-worker-task-container`, {
      image: ecs.ContainerImage.fromEcrRepository(
        nuxeoDockerAsset.repository,
        nuxeoDockerAsset.imageTag
      ),
      portMappings: [
        {
          hostPort: 8080,
          containerPort: 8080,
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${prefix}-ecs-worker-task-log-group`,
        logRetention: 30,
      }),
      environment: containerEnv,
      secrets: containerSecrets
    });

    const nuxeoWorkerService = new ecs.FargateService(
      this,
      `${prefix}-ecs-worker-service`,
      {
        serviceName: `${prefix}-ecs-worker-service`,
        cluster,
        taskDefinition: workertaskDefinition,
      }
    );

    //Create Auto Scaling Policy
    nuxeoWorkerService
      .autoScaleTaskCount({ maxCapacity: 2 })
      .scaleOnCpuUtilization(`${prefix}-ecs-worker-service-auto-scalling`, {
        targetUtilizationPercent: 50,
        scaleInCooldown: Duration.seconds(60),
        scaleOutCooldown: Duration.seconds(60),
      });
  }
}

module.exports = { NuxeoCdkStack: NuxeoCdkStack };
