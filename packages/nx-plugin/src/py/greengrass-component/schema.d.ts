/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GreengrassPlatform } from '../../utils/greengrass/constants.js';

export interface PyGreengrassComponentGeneratorSchema {
  readonly project: string;
  readonly name: string;
  readonly componentName?: string;
  readonly componentVersion?: string;
  readonly publisher?: string;
  readonly ipc?: boolean;
  readonly platform?: GreengrassPlatform;
  readonly preferInstallDependencies?: boolean;
}
