// Declarative post-deployment configuration steps — types, schema, and validation

// Types
export type {
  RefArg,
  LiteralArg,
  LiteralValue,
  ConfigArg,
  ReadArg,
  ReadCallArg,
  AddressRef,
  ConfigArgExtended,
  SetXStep,
  GrantRoleStep,
  WireStep,
  ConfigStep,
  ConfigSpec,
} from "./steps/types.js";

// Schemas
export {
  LITERAL_MAX_DEPTH,
  configArgSchema,
  readArgSchema,
  readCallArgSchema,
  addressRefSchema,
  configArgExtendedSchema,
  setXStepSchema,
  grantRoleStepSchema,
  wireStepSchema,
  configStepSchema,
  configSpecSchema,
} from "./steps/schema.js";

// Validation
export type {
  ConfigError,
  ConfigErrorCode,
  ConfigResult,
  DeploymentInput,
} from "./steps/validate.js";
export { validateConfig } from "./steps/validate.js";

// Execution engine
export { applyConfig, ConfigExecError } from "./execute/execute.js";
export type { ConfigExecErrorCode } from "./execute/errors.js";
export type {
  ApplyConfigOptions,
  ApplyConfigResult,
  ConfigExecutor,
  ConfigCall,
  ReadCall,
  ResolvedArg,
} from "./execute/types.js";
