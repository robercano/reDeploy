// Browser-safe subpath: post-deploy config step types, schema, and validation
// only. Importing this entry pulls in NO execution engine (which reaches into
// the Node-only deploy runtime), so it is safe to use from browser bundles
// (e.g. @redeploy/studio). For applyConfig (Node-only) import the root instead.

export type {
  RefArg,
  LiteralArg,
  LiteralValue,
  ConfigArg,
  AddressRef,
  ConfigArgExtended,
  SetXStep,
  GrantRoleStep,
  WireStep,
  ConfigStep,
  ConfigSpec,
} from "./types.js";

export {
  LITERAL_MAX_DEPTH,
  configArgSchema,
  addressRefSchema,
  configArgExtendedSchema,
  setXStepSchema,
  grantRoleStepSchema,
  wireStepSchema,
  configStepSchema,
  configSpecSchema,
} from "./schema.js";

export type {
  ConfigError,
  ConfigErrorCode,
  ConfigResult,
  DeploymentInput,
} from "./validate.js";
export { validateConfig } from "./validate.js";
