/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { IacOption } from '../utils/iac.js';

export interface GreengrassDeploymentGeneratorSchema {
  name: string;
  directory?: string;
  subDirectory?: string;
  target: 'thing-group' | 'thing' | 'existing-arn';
  thingGroupName?: string;
  thingName?: string;
  targetArn?: string;
  parentTargetArn?: string;
  tokenExchangeRoleArn?: string;
  artifactBucket: string;
  deploymentPolicy: 'default' | 'no-rollback' | 'rollback';
  nucleus: 'classic' | 'lite' | 'none';
  infra: 'deployment' | 'none';
  iac: IacOption;
  preferInstallDependencies?: boolean;
}
