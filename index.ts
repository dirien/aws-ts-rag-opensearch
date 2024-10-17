import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as awsx from "@pulumi/awsx";

// Create ECR repository
const awsRAGOpenSearchECR = new aws.ecr.Repository("aws-rag-opensearch-ecr-repo", {
    forceDelete: true,
    name: "rag-opensearch",
});

// Get ECR authorization token
const auth = aws.ecr.getAuthorizationTokenOutput({
    registryId: awsRAGOpenSearchECR.registryId,
});

const current = aws.getCallerIdentity({});
const accountId = current.then(current => current.accountId);

// Build and push Docker image
const awsRAGOpenSearchApp = new dockerBuild.Image("aws-rag-opensearch-app", {
    dockerfile: {
        location: "app/Dockerfile",
    },
    push: true,
    context: {
        location: "app/",
    },
    buildArgs: {
        CLOUD_PROVIDER: "aws",
    },
    platforms: [
        dockerBuild.Platform.Linux_amd64,
    ],
    tags: [
        pulumi.interpolate`${awsRAGOpenSearchECR.repositoryUrl}:latest`,
    ],
    registries: [
        {
            address: awsRAGOpenSearchECR.repositoryUrl,
            username: auth.userName,
            password: auth.password,
        }
    ],
});

// Create VPC
const awsRAGOpenSearchVPC = new awsx.ec2.Vpc("aws-rag-opensearch-vpc", {
    numberOfAvailabilityZones: 2,
    enableDnsSupport: true,
    enableDnsHostnames: true,
});


const awsRAGOpenSearchSecurityGroup = new aws.ec2.SecurityGroup("aws-rag-opensearch-security-group", {
    vpcId: awsRAGOpenSearchVPC.vpcId,
    egress: [{
        cidrBlocks: ["0.0.0.0/0"],
        fromPort: 0,
        protocol: "-1",
        toPort: 0,
    }],
    ingress: [{
        cidrBlocks: ["0.0.0.0/0"],
        fromPort: 0,
        protocol: "-1",
        toPort: 0,
    }],
});

const awsRAGOpenSearchDomain = new aws.elasticsearch.Domain("aws-rag-opensearch-domain", {
    domainName: "aws-rag-opensearch",
    elasticsearchVersion: "OpenSearch_2.11",
    clusterConfig: {
        dedicatedMasterEnabled: false,
        instanceCount: 1,
        instanceType: "t3.small.elasticsearch",
        zoneAwarenessEnabled: false,
    },
    ebsOptions: {
        ebsEnabled: true,
        volumeSize: 20,
        volumeType: "gp3",
        iops: 3000,
        throughput: 125,
    },
    vpcOptions: {
        subnetIds: [
            awsRAGOpenSearchVPC.publicSubnetIds[0]
        ],
        securityGroupIds: [awsRAGOpenSearchSecurityGroup.id],
    },
    advancedOptions: {
        "rest.action.multi.allow_explicit_index": "true",
    },
    accessPolicies: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                AWS: "*",
            },
            Action: "es:*",
            Resource: pulumi.interpolate`arn:aws:es:${aws.config.region}:${accountId}:domain/aws-rag-opensearch/*`,
        }],
    }),
});


// Create ECS cluster
const awsRAGOpenSearchECSCluster = new aws.ecs.Cluster("aws-rag-opensearch-cluster", {
    configuration: {
        executeCommandConfiguration: {
            logging: "DEFAULT",
        },
    },
    settings: [{
        name: "containerInsights",
        value: "disabled",
    }],
});

// Create ECS cluster capacity providers
const awsRAGOpenSearchECSClusterCapacityProviders = new aws.ecs.ClusterCapacityProviders("aws-rag-opensearch-cluster-capacity-providers", {
    clusterName: awsRAGOpenSearchECSCluster.name,
    capacityProviders: ["FARGATE", "FARGATE_SPOT"],
});

// Create security group
const awsRAGOpenSearchECSSecurityGroup = new aws.ec2.SecurityGroup("aws-rag-opensearch-ecs-security-group", {
    vpcId: awsRAGOpenSearchVPC.vpcId,
    egress: [{
        cidrBlocks: ["0.0.0.0/0"],
        fromPort: 0,
        protocol: "-1",
        toPort: 0,
    }],
    ingress: [{
        cidrBlocks: ["0.0.0.0/0"],
        fromPort: 0,
        protocol: "-1",
        toPort: 0,
    }],
});

// Create IAM role for ECS task execution
const awsRAGOpenSearchECSExecutionRole = new aws.iam.Role("aws-rag-opensearch-ecs-execution-role", {
    assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "ecs-tasks.amazonaws.com",
            },
        }],
    }),
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
});

// Create target group
const awsRAGOpenSearchALBTargetGroup = new aws.lb.TargetGroup("aws-rag-opensearch-alb-target-group", {
    name: "aws-rag-opensearch",
    port: 80,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: awsRAGOpenSearchVPC.vpcId,
});

// Create load balancer
const awsRAGOpenSearchALB = new aws.lb.LoadBalancer("aws-rag-opensearch-alb", {
    loadBalancerType: "application",
    securityGroups: [awsRAGOpenSearchECSSecurityGroup.id],
    subnets: awsRAGOpenSearchVPC.publicSubnetIds,
});

// Create listener
const awsRAGOpenSearchListener = new aws.lb.Listener("aws-rag-opensearch-listener", {
    loadBalancerArn: awsRAGOpenSearchALB.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: awsRAGOpenSearchALBTargetGroup.arn,
    }],
});

// Create service discovery namespace
const awsRAGOpenSearchSDNamespace = new aws.servicediscovery.PrivateDnsNamespace("aws-rag-opensearch-sd-namespace", {
    name: "aws-rag-opensearch.local",
    vpc: awsRAGOpenSearchVPC.vpcId,
});


// Create CloudWatch log group
const awsRAGOpenSearchlogGroup = new aws.cloudwatch.LogGroup("aws-rag-opensearch-log-group", {
    retentionInDays: 7,
    name: "/aws/ecs/aws-rag-opensearch"
});

// IAM Role
const awsRAGOpenSearchTaskRole = new aws.iam.Role("aws-rag-opensearch-ecs-task-role", {
    assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "ecs-tasks.amazonaws.com",
            },
        }],
    }),
});

// Inline Policies
new aws.iam.RolePolicy("aws-rag-opensearch-bedrock-policy", {
    role: awsRAGOpenSearchTaskRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["bedrock:InvokeModel"],
                Resource: ["arn:aws:bedrock:*::foundation-model/*"],
            },
        ],
    },
});

new aws.iam.RolePolicy("aws-rag-opensearch-execute-command-policy", {
    role: awsRAGOpenSearchTaskRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ssmmessages:CreateControlChannel",
                    "ssmmessages:OpenControlChannel",
                    "ssmmessages:CreateDataChannel",
                    "ssmmessages:OpenDataChannel",
                ],
                Resource: "*",
            },
            {
                Effect: "Allow",
                Action: [
                    "logs:CreateLogStream",
                    "logs:DescribeLogGroups",
                    "logs:DescribeLogStreams",
                    "logs:PutLogEvents",
                ],
                Resource: "*",
            },
        ],
    },
});

new aws.iam.RolePolicy("aws-rag-opensearch-deny-iam-policy", {
    role: awsRAGOpenSearchTaskRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Deny",
                Action: "iam:*",
                Resource: "*",
            },
        ],
    },
});

new aws.iam.RolePolicy("aws-rag-opensearch-policy", {
    role: awsRAGOpenSearchTaskRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "es:*",
                ],
                Resource: pulumi.interpolate`${awsRAGOpenSearchDomain.arn}/*`,
            },
        ],
    },
});

// Create ECS task definition
const awsRAGOpenSearchTaskDefinition = new aws.ecs.TaskDefinition("aws-rag-opensearch-task-definition", {
    containerDefinitions: pulumi.jsonStringify([{
        name: "aws-rag-opensearch-app",
        image: pulumi.interpolate`${awsRAGOpenSearchECR.repositoryUrl}:latest@${awsRAGOpenSearchApp.digest}`,
        essential: true,
        portMappings: [{
            containerPort: 8501,
            hostPort: 8501,
            protocol: "tcp",
        }],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": awsRAGOpenSearchlogGroup.name,
                "awslogs-region": aws.config.region,
                "awslogs-stream-prefix": "aws-rag-opensearch",
            },
        },
        environment: [
            {
                name: "AWS_REGION",
                value: aws.config.region,
            },
            {
                name: "OPENSEARCH_ENDPOINT",
                value: pulumi.interpolate`https://${awsRAGOpenSearchDomain.endpoint}:443`,
            },
            {
                name: "OPENSEARCH_INDEX_NAME",
                value: awsRAGOpenSearchDomain.domainName,
            },
            {
                name: "CLOUD_PROVIDER",
                value: "aws"
            }
        ],
    }]),
    cpu: "256",
    executionRoleArn: awsRAGOpenSearchECSExecutionRole.arn,
    family: "aws-rag-opensearch-task-definition",
    memory: "2048",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    taskRoleArn: awsRAGOpenSearchTaskRole.arn,
});

// Create ECS service
const awsRAGOpenSearchECSService = new aws.ecs.Service("aws-rag-opensearch-ecs-service", {
    cluster: awsRAGOpenSearchECSCluster.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    loadBalancers: [{
        containerName: "aws-rag-opensearch-app",
        containerPort: 8501,
        targetGroupArn: awsRAGOpenSearchALBTargetGroup.arn,
    }],
    networkConfiguration: {
        assignPublicIp: true,
        securityGroups: [awsRAGOpenSearchECSSecurityGroup.id],
        subnets: awsRAGOpenSearchVPC.publicSubnetIds,
    },
    schedulingStrategy: "REPLICA",
    healthCheckGracePeriodSeconds: 180,
    serviceConnectConfiguration: {
        enabled: true,
        namespace: awsRAGOpenSearchSDNamespace.name,
    },
    taskDefinition: awsRAGOpenSearchTaskDefinition.arn,
});

export const image = pulumi.interpolate`${awsRAGOpenSearchECR.repositoryUrl}:latest@${awsRAGOpenSearchApp.digest}`;
export const url = awsRAGOpenSearchALB.dnsName;

