/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GreengrassPlatformSelection } from '../../utils/greengrass/constants.js';
import type { IacOption } from '../../utils/iac.js';

export interface PyGreengrassComponentGeneratorSchema {
  readonly project: string;
  readonly name: string;
  readonly componentName?: string;
  readonly componentVersion?: string;
  readonly publisher?: string;
  readonly ipc?: boolean;
  readonly platform?: GreengrassPlatformSelection;
  readonly infra?: 'component-version' | 'none';
  readonly iac?: IacOption;
  readonly preferInstallDependencies?: boolean;
}
