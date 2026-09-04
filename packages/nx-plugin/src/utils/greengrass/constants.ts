/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `RecipeFormatVersion` a Greengrass v2 recipe declares. Fixed by the
 * service since the format's introduction; there is no later version to
 * migrate to.
 */
export const RECIPE_FORMAT_VERSION = '2020-01-25' as const;

/**
 * Component platforms the generator supports. Multi-architecture manifests,
 * Windows and `linux-any` are deferred: `awscrt` (the native binding the IPC
 * client pulls in) ships architecture-specific wheels, so one artifact cannot
 * serve both architectures.
 */
export const GREENGRASS_PLATFORMS = ['linux-amd64', 'linux-arm64'] as const;

export type GreengrassPlatform = (typeof GREENGRASS_PLATFORMS)[number];

/**
 * `Platform.os` / `Platform.architecture` values written into a recipe manifest.
 * The nucleus matches `aarch64` (not the Docker-style `arm64`) on 64-bit ARM
 * devices - verified against a real core device reporting
 * `{os=linux, architecture=aarch64}`.
 */
export interface GreengrassManifestPlatform {
  readonly os: 'linux';
  readonly architecture: 'amd64' | 'aarch64';
}

/** How a {@link GreengrassPlatform} maps onto a `uv` target platform and a manifest `Platform` block. */
export interface GreengrassPlatformMapping {
  /** Value for `uv`'s `--python-platform` flag when vendoring dependencies. */
  readonly uvPlatform: 'x86_64-manylinux_2_28' | 'aarch64-manylinux_2_28';
  readonly manifestPlatform: GreengrassManifestPlatform;
}

/**
 * Per-platform `uv` target and recipe manifest `Platform` block. Mirrors the
 * platform strings `addPythonBundleTarget` uses for Lambda, but this map is
 * not shared with it: a device's Python floor is not a Lambda runtime.
 */
export const GREENGRASS_PLATFORM_MAPPINGS: Readonly<
  Record<GreengrassPlatform, GreengrassPlatformMapping>
> = {
  'linux-amd64': {
    uvPlatform: 'x86_64-manylinux_2_28',
    manifestPlatform: { os: 'linux', architecture: 'amd64' },
  },
  'linux-arm64': {
    uvPlatform: 'aarch64-manylinux_2_28',
    manifestPlatform: { os: 'linux', architecture: 'aarch64' },
  },
} as const;

/**
 * Top-level key in `aws-nx-plugin.config.mts` under which Greengrass-specific
 * workspace defaults (currently just the publisher) may be set. Read by the
 * component generator, not by these utilities.
 */
export const GREENGRASS_CONFIG_KEY = 'greengrass' as const;

/**
 * Key under {@link GREENGRASS_CONFIG_KEY} holding the default `ComponentPublisher`.
 *
 * Fallback order the generator applies, never a hardcoded literal:
 * 1. `greengrass.publisher` in `aws-nx-plugin.config.mts`, when set.
 * 2. The workspace's npm scope (see `getNpmScope` in `../npm-scope.js`).
 */
export const GREENGRASS_PUBLISHER_CONFIG_KEY = 'publisher' as const;

/**
 * Shape of the `greengrass` block in `aws-nx-plugin.config.mts`, keyed by
 * {@link GREENGRASS_CONFIG_KEY}. Wired into `AwsNxPluginConfig` in
 * `../config/index.js`; resolved by the component generator, not here.
 */
export interface GreengrassConfig {
  /** Default `ComponentPublisher` for new components, keyed by {@link GREENGRASS_PUBLISHER_CONFIG_KEY}. */
  publisher?: string;
}
