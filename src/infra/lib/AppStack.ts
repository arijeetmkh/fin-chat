import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';


export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', { 
      
      availabilityZones: ['ca-central-1a', 'ca-central-1b'],
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ]
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for the VPC endpoints',
    });

    const appServiceECSSecurityGroup = new ec2.SecurityGroup(this, 'AppServiceECSSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for the ECS service'
    });

    endpointSecurityGroup.addIngressRule(
      appServiceECSSecurityGroup,
      ec2.Port.tcp(443),
      'Allow inbound HTTPS traffic from the ECS service'
    );

    // Create VPC Endpoints for ECS -> ECR image pulling
    new ec2.InterfaceVpcEndpoint(this, 'ECRAPIEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: ['ca-central-1a', 'ca-central-1b']
      }
    });
    new ec2.InterfaceVpcEndpoint(this, 'EcrDkrEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: ['ca-central-1a', 'ca-central-1b']
      }
    });
    new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: ['ca-central-1a', 'ca-central-1b']
      }]
    });
    // VPC Endpoint for CloudWatch Logs
    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: ['ca-central-1a', 'ca-central-1b']
      }
    });
    //VPC Endpoint for CloudWatch (Metrics)
    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        availabilityZones: ['ca-central-1a', 'ca-central-1b']
      }
    });

    
    // Start Docker Image upload
    const nodeAppImageAsset = new DockerImageAsset(this, 'nodeAppImageAsset', {
      directory: path.join(__dirname, '../..', 'fin-chat'),
      assetName: 'fin-chat'
    });

    new cdk.CfnOutput(this, "fin-chat-image-uri", {
      value: nodeAppImageAsset.imageUri
    })

    const appCluster = new ecs.Cluster(this, 'appCluster', {
      vpc
    });

    const appTaskDefinition = new ecs.FargateTaskDefinition(this, 'appTaskDefinition');
    appTaskDefinition.addContainer('appContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(nodeAppImageAsset),
      memoryLimitMiB: 512,
      environment: {
        PORT: '3000',
        NODE_ENV: 'production',
      },
      portMappings: [{ containerPort: 3000 }]
    });

    const appService = new ecs.FargateService(this, 'appService', {
      serviceName: 'fin-chat',
      cluster: appCluster,
      taskDefinition: appTaskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      },
      securityGroups: [appServiceECSSecurityGroup]
    });

    const finChatAlb = new elbv2.ApplicationLoadBalancer(this, 'fin-chat-ALB', {
      vpc, internetFacing: false
    });

    const albListener = finChatAlb.addListener('Listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true
      })
    });

    const albTLSListener = finChatAlb.addListener('TLSListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Certificate', 'arn:aws:acm:ca-central-1:766932390969:certificate/a34b31d7-7834-4bce-ae00-9b6a8f61b266')]
    });

    appService.registerLoadBalancerTargets({
      containerName: 'appContainer',
      containerPort: 3000,
      newTargetGroupId: 'fin-chat-target',
      listener: ecs.ListenerConfig.applicationListener(albTLSListener, {
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 443,
        healthCheck: {
          path: '/',
          port: '3000',
          protocol: elbv2.Protocol.HTTP,
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3
        }
      })
    })

    const finChatNlb = new elbv2.NetworkLoadBalancer(this, 'fin-chat-NLB', {
      vpc, internetFacing: true
    });
    const nlbListener = finChatNlb.addListener('Listener', {
      port: 443,
      protocol: elbv2.Protocol.TCP
    });
    
    nlbListener.addTargets('fin-chat-alb-target', {
      port: 443,
      targets: [new targets.AlbListenerTarget(albTLSListener)],
      healthCheck: {
        port: '443',
        protocol: elbv2.Protocol.HTTPS,
        enabled: true
      }
    });
    
  }
}
