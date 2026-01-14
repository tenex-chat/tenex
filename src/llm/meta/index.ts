/**
 * Meta Model Module
 *
 * Provides dynamic model selection capabilities through "meta models".
 * Meta models are virtual configurations that resolve to real models
 * based on keywords in user messages.
 *
 * @module
 */

export { MetaModelResolver, type MetaModelResolution, type ResolveOptions } from "./MetaModelResolver";
