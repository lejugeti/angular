/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ConstantPool} from '../../../constant_pool';
import {SecurityContext} from '../../../core';
import * as e from '../../../expression_parser/ast';
import * as i18n from '../../../i18n/i18n_ast';
import {splitNsName} from '../../../ml_parser/tags';
import * as o from '../../../output/output_ast';
import {ParseSourceSpan} from '../../../parse_util';
import * as t from '../../../render3/r3_ast';
import {R3DeferBlockMetadata} from '../../../render3/view/api';
import {icuFromI18nMessage, isSingleI18nIcu} from '../../../render3/view/i18n/util';
import {DomElementSchemaRegistry} from '../../../schema/dom_element_schema_registry';
import {BindingParser} from '../../../template_parser/binding_parser';
import * as ir from '../ir';

import {CompilationUnit, ComponentCompilationJob, HostBindingCompilationJob, type CompilationJob, type ViewCompilationUnit} from './compilation';
import {BINARY_OPERATORS, namespaceForKey, prefixWithNamespace} from './conversion';

const compatibilityMode = ir.CompatibilityMode.TemplateDefinitionBuilder;

// Schema containing DOM elements and their properties.
const domSchema = new DomElementSchemaRegistry();

// Tag name of the `ng-template` element.
const NG_TEMPLATE_TAG_NAME = 'ng-template';

/**
 * Process a template AST and convert it into a `ComponentCompilation` in the intermediate
 * representation.
 * TODO: Refactor more of the ingestion code into phases.
 */
export function ingestComponent(
    componentName: string, template: t.Node[], constantPool: ConstantPool,
    relativeContextFilePath: string, i18nUseExternalIds: boolean,
    deferBlocksMeta: Map<t.DeferredBlock, R3DeferBlockMetadata>): ComponentCompilationJob {
  const job = new ComponentCompilationJob(
      componentName, constantPool, compatibilityMode, relativeContextFilePath, i18nUseExternalIds,
      deferBlocksMeta);
  ingestNodes(job.root, template);
  return job;
}

export interface HostBindingInput {
  componentName: string;
  componentSelector: string;
  properties: e.ParsedProperty[]|null;
  attributes: {[key: string]: o.Expression};
  events: e.ParsedEvent[]|null;
}

/**
 * Process a host binding AST and convert it into a `HostBindingCompilationJob` in the intermediate
 * representation.
 */
export function ingestHostBinding(
    input: HostBindingInput, bindingParser: BindingParser,
    constantPool: ConstantPool): HostBindingCompilationJob {
  const job = new HostBindingCompilationJob(input.componentName, constantPool, compatibilityMode);
  for (const property of input.properties ?? []) {
    let bindingKind = ir.BindingKind.Property;
    // TODO: this should really be handled in the parser.
    if (property.name.startsWith('attr.')) {
      property.name = property.name.substring('attr.'.length);
      bindingKind = ir.BindingKind.Attribute;
    }
    if (property.isAnimation) {
      bindingKind = ir.BindingKind.Animation;
    }
    const securityContexts =
        bindingParser
            .calcPossibleSecurityContexts(
                input.componentSelector, property.name, bindingKind === ir.BindingKind.Attribute)
            .filter(context => context !== SecurityContext.NONE);
    ingestHostProperty(job, property, bindingKind, securityContexts);
  }
  for (const [name, expr] of Object.entries(input.attributes) ?? []) {
    const securityContexts =
        bindingParser.calcPossibleSecurityContexts(input.componentSelector, name, true)
            .filter(context => context !== SecurityContext.NONE);
    ingestHostAttribute(job, name, expr, securityContexts);
  }
  for (const event of input.events ?? []) {
    ingestHostEvent(job, event);
  }
  return job;
}

// TODO: We should refactor the parser to use the same types and structures for host bindings as
// with ordinary components. This would allow us to share a lot more ingestion code.
export function ingestHostProperty(
    job: HostBindingCompilationJob, property: e.ParsedProperty, bindingKind: ir.BindingKind,
    securityContexts: SecurityContext[]): void {
  let expression: o.Expression|ir.Interpolation;
  const ast = property.expression.ast;
  if (ast instanceof e.Interpolation) {
    expression = new ir.Interpolation(
        ast.strings, ast.expressions.map(expr => convertAst(expr, job, property.sourceSpan)), []);
  } else {
    expression = convertAst(ast, job, property.sourceSpan);
  }
  job.root.update.push(ir.createBindingOp(
      job.root.xref, bindingKind, property.name, expression, null, securityContexts, false, false,
      null, /* TODO: How do Host bindings handle i18n attrs? */ null, property.sourceSpan));
}

export function ingestHostAttribute(
    job: HostBindingCompilationJob, name: string, value: o.Expression,
    securityContexts: SecurityContext[]): void {
  const attrBinding = ir.createBindingOp(
      job.root.xref, ir.BindingKind.Attribute, name, value, null, securityContexts,
      /* Host attributes should always be extracted to const hostAttrs, even if they are not
       *strictly* text literals */
      true, false, null,
      /* TODO */ null,
      /** TODO: May be null? */ value.sourceSpan!);
  job.root.update.push(attrBinding);
}

export function ingestHostEvent(job: HostBindingCompilationJob, event: e.ParsedEvent) {
  const [phase, target] = event.type === e.ParsedEventType.Regular ? [null, event.targetOrPhase] :
                                                                     [event.targetOrPhase, null];
  const eventBinding = ir.createListenerOp(
      job.root.xref, new ir.SlotHandle(), event.name, null,
      makeListenerHandlerOps(job.root, event.handler, event.handlerSpan), phase, target, true,
      event.sourceSpan);
  job.root.create.push(eventBinding);
}

/**
 * Ingest the nodes of a template AST into the given `ViewCompilation`.
 */
function ingestNodes(unit: ViewCompilationUnit, template: t.Node[]): void {
  for (const node of template) {
    if (node instanceof t.Element) {
      ingestElement(unit, node);
    } else if (node instanceof t.Template) {
      ingestTemplate(unit, node);
    } else if (node instanceof t.Content) {
      ingestContent(unit, node);
    } else if (node instanceof t.Text) {
      ingestText(unit, node, null);
    } else if (node instanceof t.BoundText) {
      ingestBoundText(unit, node, null);
    } else if (node instanceof t.IfBlock) {
      ingestIfBlock(unit, node);
    } else if (node instanceof t.SwitchBlock) {
      ingestSwitchBlock(unit, node);
    } else if (node instanceof t.DeferredBlock) {
      ingestDeferBlock(unit, node);
    } else if (node instanceof t.Icu) {
      ingestIcu(unit, node);
    } else if (node instanceof t.ForLoopBlock) {
      ingestForBlock(unit, node);
    } else {
      throw new Error(`Unsupported template node: ${node.constructor.name}`);
    }
  }
}

/**
 * Ingest an element AST from the template into the given `ViewCompilation`.
 */
function ingestElement(unit: ViewCompilationUnit, element: t.Element): void {
  if (element.i18n !== undefined &&
      !(element.i18n instanceof i18n.Message || element.i18n instanceof i18n.TagPlaceholder)) {
    throw Error(`Unhandled i18n metadata type for element: ${element.i18n.constructor.name}`);
  }

  const id = unit.job.allocateXrefId();

  const [namespaceKey, elementName] = splitNsName(element.name);

  const startOp = ir.createElementStartOp(
      elementName, id, namespaceForKey(namespaceKey),
      element.i18n instanceof i18n.TagPlaceholder ? element.i18n : undefined,
      element.startSourceSpan, element.sourceSpan);
  unit.create.push(startOp);

  ingestElementBindings(unit, startOp, element);
  ingestReferences(startOp, element);

  // Start i18n, if needed, goes after the element create and bindings, but before the nodes
  let i18nBlockId: ir.XrefId|null = null;
  if (element.i18n instanceof i18n.Message) {
    i18nBlockId = unit.job.allocateXrefId();
    unit.create.push(
        ir.createI18nStartOp(i18nBlockId, element.i18n, undefined, element.startSourceSpan));
  }

  ingestNodes(unit, element.children);

  // The source span for the end op is typically the element closing tag. However, if no closing tag
  // exists, such as in `<input>`, we use the start source span instead. Usually the start and end
  // instructions will be collapsed into one `element` instruction, negating the purpose of this
  // fallback, but in cases when it is not collapsed (such as an input with a binding), we still
  // want to map the end instruction to the main element.
  const endOp = ir.createElementEndOp(id, element.endSourceSpan ?? element.startSourceSpan);
  unit.create.push(endOp);

  // If there is an i18n message associated with this element, insert i18n start and end ops.
  if (i18nBlockId !== null) {
    ir.OpList.insertBefore<ir.CreateOp>(
        ir.createI18nEndOp(i18nBlockId, element.endSourceSpan ?? element.startSourceSpan), endOp);
  }
}

/**
 * Ingest an `ng-template` node from the AST into the given `ViewCompilation`.
 */
function ingestTemplate(unit: ViewCompilationUnit, tmpl: t.Template): void {
  if (tmpl.i18n !== undefined &&
      !(tmpl.i18n instanceof i18n.Message || tmpl.i18n instanceof i18n.TagPlaceholder)) {
    throw Error(`Unhandled i18n metadata type for template: ${tmpl.i18n.constructor.name}`);
  }

  const childView = unit.job.allocateView(unit.xref);

  let tagNameWithoutNamespace = tmpl.tagName;
  let namespacePrefix: string|null = '';
  if (tmpl.tagName) {
    [namespacePrefix, tagNameWithoutNamespace] = splitNsName(tmpl.tagName);
  }

  const i18nPlaceholder = tmpl.i18n instanceof i18n.TagPlaceholder ? tmpl.i18n : undefined;
  const namespace = namespaceForKey(namespacePrefix);
  const functionNameSuffix = tagNameWithoutNamespace === null ?
      '' :
      prefixWithNamespace(tagNameWithoutNamespace, namespace);
  const templateKind =
      isPlainTemplate(tmpl) ? ir.TemplateKind.NgTemplate : ir.TemplateKind.Structural;
  const templateOp = ir.createTemplateOp(
      childView.xref, templateKind, tagNameWithoutNamespace, functionNameSuffix, namespace,
      i18nPlaceholder, tmpl.startSourceSpan, tmpl.sourceSpan);
  unit.create.push(templateOp);

  ingestTemplateBindings(unit, templateOp, tmpl, templateKind);
  ingestReferences(templateOp, tmpl);
  ingestNodes(childView, tmpl.children);

  for (const {name, value} of tmpl.variables) {
    childView.contextVariables.set(name, value !== '' ? value : '$implicit');
  }

  // If this is a plain template and there is an i18n message associated with it, insert i18n start
  // and end ops. For structural directive templates, the i18n ops will be added when ingesting the
  // element/template the directive is placed on.
  if (templateKind === ir.TemplateKind.NgTemplate && tmpl.i18n instanceof i18n.Message) {
    const id = unit.job.allocateXrefId();
    ir.OpList.insertAfter(
        ir.createI18nStartOp(id, tmpl.i18n, undefined, tmpl.startSourceSpan),
        childView.create.head);
    ir.OpList.insertBefore(
        ir.createI18nEndOp(id, tmpl.endSourceSpan ?? tmpl.startSourceSpan), childView.create.tail);
  }
}

/**
 * Ingest a content node from the AST into the given `ViewCompilation`.
 */
function ingestContent(unit: ViewCompilationUnit, content: t.Content): void {
  if (content.i18n !== undefined && !(content.i18n instanceof i18n.TagPlaceholder)) {
    throw Error(`Unhandled i18n metadata type for element: ${content.i18n.constructor.name}`);
  }
  const op = ir.createProjectionOp(
      unit.job.allocateXrefId(), content.selector, content.i18n, content.sourceSpan);
  for (const attr of content.attributes) {
    const securityContext = domSchema.securityContext(content.name, attr.name, true);
    unit.update.push(ir.createBindingOp(
        op.xref, ir.BindingKind.Attribute, attr.name, o.literal(attr.value), null, securityContext,
        true, false, null, asMessage(attr.i18n), attr.sourceSpan));
  }
  unit.create.push(op);
}

/**
 * Ingest a literal text node from the AST into the given `ViewCompilation`.
 */
function ingestText(unit: ViewCompilationUnit, text: t.Text, icuPlaceholder: string|null): void {
  unit.create.push(
      ir.createTextOp(unit.job.allocateXrefId(), text.value, icuPlaceholder, text.sourceSpan));
}

/**
 * Ingest an interpolated text node from the AST into the given `ViewCompilation`.
 */
function ingestBoundText(
    unit: ViewCompilationUnit, text: t.BoundText, icuPlaceholder: string|null): void {
  let value = text.value;
  if (value instanceof e.ASTWithSource) {
    value = value.ast;
  }
  if (!(value instanceof e.Interpolation)) {
    throw new Error(
        `AssertionError: expected Interpolation for BoundText node, got ${value.constructor.name}`);
  }
  if (text.i18n !== undefined && !(text.i18n instanceof i18n.Container)) {
    throw Error(
        `Unhandled i18n metadata type for text interpolation: ${text.i18n?.constructor.name}`);
  }

  const i18nPlaceholders = text.i18n instanceof i18n.Container ?
      text.i18n.children
          .filter((node): node is i18n.Placeholder => node instanceof i18n.Placeholder)
          .map(placeholder => placeholder.name) :
      [];
  if (i18nPlaceholders.length > 0 && i18nPlaceholders.length !== value.expressions.length) {
    throw Error(`Unexpected number of i18n placeholders (${
        value.expressions.length}) for BoundText with ${value.expressions.length} expressions`);
  }

  const textXref = unit.job.allocateXrefId();
  unit.create.push(ir.createTextOp(textXref, '', icuPlaceholder, text.sourceSpan));
  // TemplateDefinitionBuilder does not generate source maps for sub-expressions inside an
  // interpolation. We copy that behavior in compatibility mode.
  // TODO: is it actually correct to generate these extra maps in modern mode?
  const baseSourceSpan = unit.job.compatibility ? null : text.sourceSpan;
  unit.update.push(ir.createInterpolateTextOp(
      textXref,
      new ir.Interpolation(
          value.strings, value.expressions.map(expr => convertAst(expr, unit.job, baseSourceSpan)),
          i18nPlaceholders),
      text.sourceSpan));
}

/**
 * Ingest an `@if` block into the given `ViewCompilation`.
 */
function ingestIfBlock(unit: ViewCompilationUnit, ifBlock: t.IfBlock): void {
  let firstXref: ir.XrefId|null = null;
  let firstSlotHandle: ir.SlotHandle|null = null;
  let conditions: Array<ir.ConditionalCaseExpr> = [];
  for (let i = 0; i < ifBlock.branches.length; i++) {
    const ifCase = ifBlock.branches[i];
    const cView = unit.job.allocateView(unit.xref);
    let tagName: string|null = null;

    // Only the first branch can be used for projection, because the conditional
    // uses the container of the first branch as the insertion point for all branches.
    if (i === 0) {
      tagName = ingestControlFlowInsertionPoint(unit, cView.xref, ifCase);
    }
    if (ifCase.expressionAlias !== null) {
      cView.contextVariables.set(ifCase.expressionAlias.name, ir.CTX_REF);
    }

    let ifCaseI18nMeta = undefined;
    if (ifCase.i18n !== undefined) {
      if (!(ifCase.i18n instanceof i18n.BlockPlaceholder)) {
        throw Error(`Unhandled i18n metadata type for if block: ${ifCase.i18n?.constructor.name}`);
      }
      ifCaseI18nMeta = ifCase.i18n;
    }

    const templateOp = ir.createTemplateOp(
        cView.xref, ir.TemplateKind.Block, tagName, 'Conditional', ir.Namespace.HTML,
        ifCaseI18nMeta, ifCase.startSourceSpan, ifCase.sourceSpan);
    unit.create.push(templateOp);

    if (firstXref === null) {
      firstXref = cView.xref;
      firstSlotHandle = templateOp.handle;
    }

    const caseExpr = ifCase.expression ? convertAst(ifCase.expression, unit.job, null) : null;
    const conditionalCaseExpr = new ir.ConditionalCaseExpr(
        caseExpr, templateOp.xref, templateOp.handle, ifCase.expressionAlias);
    conditions.push(conditionalCaseExpr);
    ingestNodes(cView, ifCase.children);
  }
  const conditional =
      ir.createConditionalOp(firstXref!, firstSlotHandle!, null, conditions, ifBlock.sourceSpan);
  unit.update.push(conditional);
}

/**
 * Ingest an `@switch` block into the given `ViewCompilation`.
 */
function ingestSwitchBlock(unit: ViewCompilationUnit, switchBlock: t.SwitchBlock): void {
  // Don't ingest empty switches since they won't render anything.
  if (switchBlock.cases.length === 0) {
    return;
  }

  let firstXref: ir.XrefId|null = null;
  let firstSlotHandle: ir.SlotHandle|null = null;
  let conditions: Array<ir.ConditionalCaseExpr> = [];
  for (const switchCase of switchBlock.cases) {
    const cView = unit.job.allocateView(unit.xref);
    let switchCaseI18nMeta = undefined;
    if (switchCase.i18n !== undefined) {
      if (!(switchCase.i18n instanceof i18n.BlockPlaceholder)) {
        throw Error(
            `Unhandled i18n metadata type for switch block: ${switchCase.i18n?.constructor.name}`);
      }
      switchCaseI18nMeta = switchCase.i18n;
    }
    const templateOp = ir.createTemplateOp(
        cView.xref, ir.TemplateKind.Block, null, 'Case', ir.Namespace.HTML, switchCaseI18nMeta,
        switchCase.startSourceSpan, switchCase.sourceSpan);
    unit.create.push(templateOp);
    if (firstXref === null) {
      firstXref = cView.xref;
      firstSlotHandle = templateOp.handle;
    }
    const caseExpr = switchCase.expression ?
        convertAst(switchCase.expression, unit.job, switchBlock.startSourceSpan) :
        null;
    const conditionalCaseExpr =
        new ir.ConditionalCaseExpr(caseExpr, templateOp.xref, templateOp.handle);
    conditions.push(conditionalCaseExpr);
    ingestNodes(cView, switchCase.children);
  }
  const conditional = ir.createConditionalOp(
      firstXref!, firstSlotHandle!, convertAst(switchBlock.expression, unit.job, null), conditions,
      switchBlock.sourceSpan);
  unit.update.push(conditional);
}

function ingestDeferView(
    unit: ViewCompilationUnit, suffix: string, i18nMeta: i18n.I18nMeta|undefined,
    children?: t.Node[], sourceSpan?: ParseSourceSpan): ir.TemplateOp|null {
  if (i18nMeta !== undefined && !(i18nMeta instanceof i18n.BlockPlaceholder)) {
    throw Error('Unhandled i18n metadata type for defer block');
  }
  if (children === undefined) {
    return null;
  }
  const secondaryView = unit.job.allocateView(unit.xref);
  ingestNodes(secondaryView, children);
  const templateOp = ir.createTemplateOp(
      secondaryView.xref, ir.TemplateKind.Block, null, `Defer${suffix}`, ir.Namespace.HTML,
      i18nMeta, sourceSpan!, sourceSpan!);
  unit.create.push(templateOp);
  return templateOp;
}

function ingestDeferBlock(unit: ViewCompilationUnit, deferBlock: t.DeferredBlock): void {
  const blockMeta = unit.job.deferBlocksMeta.get(deferBlock);
  if (blockMeta === undefined) {
    throw new Error(`AssertionError: unable to find metadata for deferred block`);
  }

  // Generate the defer main view and all secondary views.
  const main =
      ingestDeferView(unit, '', deferBlock.i18n, deferBlock.children, deferBlock.sourceSpan)!;
  const loading = ingestDeferView(
      unit, 'Loading', deferBlock.loading?.i18n, deferBlock.loading?.children,
      deferBlock.loading?.sourceSpan);
  const placeholder = ingestDeferView(
      unit, 'Placeholder', deferBlock.placeholder?.i18n, deferBlock.placeholder?.children,
      deferBlock.placeholder?.sourceSpan);
  const error = ingestDeferView(
      unit, 'Error', deferBlock.error?.i18n, deferBlock.error?.children,
      deferBlock.error?.sourceSpan);

  // Create the main defer op, and ops for all secondary views.
  const deferXref = unit.job.allocateXrefId();
  const deferOp =
      ir.createDeferOp(deferXref, main.xref, main.handle, blockMeta, deferBlock.sourceSpan);
  deferOp.placeholderView = placeholder?.xref ?? null;
  deferOp.placeholderSlot = placeholder?.handle ?? null;
  deferOp.loadingSlot = loading?.handle ?? null;
  deferOp.errorSlot = error?.handle ?? null;
  deferOp.placeholderMinimumTime = deferBlock.placeholder?.minimumTime ?? null;
  deferOp.loadingMinimumTime = deferBlock.loading?.minimumTime ?? null;
  deferOp.loadingAfterTime = deferBlock.loading?.afterTime ?? null;
  unit.create.push(deferOp);

  // Configure all defer `on` conditions.
  // TODO: refactor prefetch triggers to use a separate op type, with a shared superclass. This will
  // make it easier to refactor prefetch behavior in the future.
  let prefetch = false;
  let deferOnOps: ir.DeferOnOp[] = [];
  let deferWhenOps: ir.DeferWhenOp[] = [];
  for (const triggers of [deferBlock.triggers, deferBlock.prefetchTriggers]) {
    if (triggers.idle !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {kind: ir.DeferTriggerKind.Idle}, prefetch, triggers.idle.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.immediate !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {kind: ir.DeferTriggerKind.Immediate}, prefetch,
          triggers.immediate.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.timer !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {kind: ir.DeferTriggerKind.Timer, delay: triggers.timer.delay}, prefetch,
          triggers.timer.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.hover !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {
            kind: ir.DeferTriggerKind.Hover,
            targetName: triggers.hover.reference,
            targetXref: null,
            targetSlot: null,
            targetView: null,
            targetSlotViewSteps: null,
          },
          prefetch, triggers.hover.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.interaction !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {
            kind: ir.DeferTriggerKind.Interaction,
            targetName: triggers.interaction.reference,
            targetXref: null,
            targetSlot: null,
            targetView: null,
            targetSlotViewSteps: null,
          },
          prefetch, triggers.interaction.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.viewport !== undefined) {
      const deferOnOp = ir.createDeferOnOp(
          deferXref, {
            kind: ir.DeferTriggerKind.Viewport,
            targetName: triggers.viewport.reference,
            targetXref: null,
            targetSlot: null,
            targetView: null,
            targetSlotViewSteps: null,
          },
          prefetch, triggers.viewport.sourceSpan);
      deferOnOps.push(deferOnOp);
    }
    if (triggers.when !== undefined) {
      if (triggers.when.value instanceof e.Interpolation) {
        // TemplateDefinitionBuilder supports this case, but it's very strange to me. What would it
        // even mean?
        throw new Error(`Unexpected interpolation in defer block when trigger`);
      }
      const deferOnOp = ir.createDeferWhenOp(
          deferXref, convertAst(triggers.when.value, unit.job, triggers.when.sourceSpan), prefetch,
          triggers.when.sourceSpan);
      deferWhenOps.push(deferOnOp);
    }

    // If no (non-prefetching) defer triggers were provided, default to `idle`.
    if (deferOnOps.length === 0 && deferWhenOps.length === 0) {
      deferOnOps.push(
          ir.createDeferOnOp(deferXref, {kind: ir.DeferTriggerKind.Idle}, false, null!));
    }
    prefetch = true;
  }

  unit.create.push(deferOnOps);
  unit.update.push(deferWhenOps);
}

function ingestIcu(unit: ViewCompilationUnit, icu: t.Icu) {
  if (icu.i18n instanceof i18n.Message && isSingleI18nIcu(icu.i18n)) {
    const xref = unit.job.allocateXrefId();
    const icuNode = icu.i18n.nodes[0];
    unit.create.push(ir.createIcuStartOp(xref, icu.i18n, icuFromI18nMessage(icu.i18n).name, null!));
    for (const [placeholder, text] of Object.entries({...icu.vars, ...icu.placeholders})) {
      if (text instanceof t.BoundText) {
        ingestBoundText(unit, text, placeholder);
      } else {
        ingestText(unit, text, placeholder);
      }
    }
    unit.create.push(ir.createIcuEndOp(xref));
  } else {
    throw Error(`Unhandled i18n metadata type for ICU: ${icu.i18n?.constructor.name}`);
  }
}

/**
 * Ingest an `@for` block into the given `ViewCompilation`.
 */
function ingestForBlock(unit: ViewCompilationUnit, forBlock: t.ForLoopBlock): void {
  const repeaterView = unit.job.allocateView(unit.xref);

  // Set all the context variables and aliases available in the repeater.
  repeaterView.contextVariables.set(forBlock.item.name, forBlock.item.value);
  repeaterView.contextVariables.set(
      forBlock.contextVariables.$index.name, forBlock.contextVariables.$index.value);
  repeaterView.contextVariables.set(
      forBlock.contextVariables.$count.name, forBlock.contextVariables.$count.value);

  // We copy TemplateDefinitionBuilder's scheme of creating names for `$count` and `$index` that are
  // suffixed with special information, to disambiguate which level of nested loop the below aliases
  // refer to.
  // TODO: We should refactor Template Pipeline's variable phases to gracefully handle shadowing,
  // and arbitrarily many levels of variables depending on each other.
  const indexName = `ɵ${forBlock.contextVariables.$index.name}_${repeaterView.xref}`;
  const countName = `ɵ${forBlock.contextVariables.$count.name}_${repeaterView.xref}`;
  repeaterView.contextVariables.set(indexName, forBlock.contextVariables.$index.value);
  repeaterView.contextVariables.set(countName, forBlock.contextVariables.$count.value);

  repeaterView.aliases.add({
    kind: ir.SemanticVariableKind.Alias,
    name: null,
    identifier: forBlock.contextVariables.$first.name,
    expression: new ir.LexicalReadExpr(indexName).identical(o.literal(0))
  });
  repeaterView.aliases.add({
    kind: ir.SemanticVariableKind.Alias,
    name: null,
    identifier: forBlock.contextVariables.$last.name,
    expression: new ir.LexicalReadExpr(indexName).identical(
        new ir.LexicalReadExpr(countName).minus(o.literal(1)))
  });
  repeaterView.aliases.add({
    kind: ir.SemanticVariableKind.Alias,
    name: null,
    identifier: forBlock.contextVariables.$even.name,
    expression: new ir.LexicalReadExpr(indexName).modulo(o.literal(2)).identical(o.literal(0))
  });
  repeaterView.aliases.add({
    kind: ir.SemanticVariableKind.Alias,
    name: null,
    identifier: forBlock.contextVariables.$odd.name,
    expression: new ir.LexicalReadExpr(indexName).modulo(o.literal(2)).notIdentical(o.literal(0))
  });

  const sourceSpan = convertSourceSpan(forBlock.trackBy.span, forBlock.sourceSpan);
  const track = convertAst(forBlock.trackBy, unit.job, sourceSpan);

  ingestNodes(repeaterView, forBlock.children);

  let emptyView: ViewCompilationUnit|null = null;
  let emptyTagName: string|null = null;
  if (forBlock.empty !== null) {
    emptyView = unit.job.allocateView(unit.xref);
    ingestNodes(emptyView, forBlock.empty.children);
    emptyTagName = ingestControlFlowInsertionPoint(unit, emptyView.xref, forBlock.empty);
  }

  const varNames: ir.RepeaterVarNames = {
    $index: forBlock.contextVariables.$index.name,
    $count: forBlock.contextVariables.$count.name,
    $first: forBlock.contextVariables.$first.name,
    $last: forBlock.contextVariables.$last.name,
    $even: forBlock.contextVariables.$even.name,
    $odd: forBlock.contextVariables.$odd.name,
    $implicit: forBlock.item.name,
  };

  if (forBlock.i18n !== undefined && !(forBlock.i18n instanceof i18n.BlockPlaceholder)) {
    throw Error('AssertionError: Unhandled i18n metadata type or @for');
  }
  if (forBlock.empty?.i18n !== undefined &&
      !(forBlock.empty.i18n instanceof i18n.BlockPlaceholder)) {
    throw Error('AssertionError: Unhandled i18n metadata type or @empty');
  }
  const i18nPlaceholder = forBlock.i18n;
  const emptyI18nPlaceholder = forBlock.empty?.i18n;

  const tagName = ingestControlFlowInsertionPoint(unit, repeaterView.xref, forBlock);
  const repeaterCreate = ir.createRepeaterCreateOp(
      repeaterView.xref, emptyView?.xref ?? null, tagName, track, varNames, emptyTagName,
      i18nPlaceholder, emptyI18nPlaceholder, forBlock.startSourceSpan, forBlock.sourceSpan);
  unit.create.push(repeaterCreate);

  const expression = convertAst(
      forBlock.expression, unit.job,
      convertSourceSpan(forBlock.expression.span, forBlock.sourceSpan));
  const repeater = ir.createRepeaterOp(
      repeaterCreate.xref, repeaterCreate.handle, expression, forBlock.sourceSpan);
  unit.update.push(repeater);
}

/**
 * Convert a template AST expression into an output AST expression.
 */
function convertAst(
    ast: e.AST, job: CompilationJob, baseSourceSpan: ParseSourceSpan|null): o.Expression {
  if (ast instanceof e.ASTWithSource) {
    return convertAst(ast.ast, job, baseSourceSpan);
  } else if (ast instanceof e.PropertyRead) {
    const isThisReceiver = ast.receiver instanceof e.ThisReceiver;
    // Whether this is an implicit receiver, *excluding* explicit reads of `this`.
    const isImplicitReceiver =
        ast.receiver instanceof e.ImplicitReceiver && !(ast.receiver instanceof e.ThisReceiver);
    // Whether the  name of the read is a node that should be never retain its explicit this
    // receiver.
    const isSpecialNode = ast.name === '$any' || ast.name === '$event';
    // TODO: The most sensible condition here would be simply `isImplicitReceiver`, to convert only
    // actual implicit `this` reads, and not explicit ones. However, TemplateDefinitionBuilder (and
    // the Typecheck block!) both have the same bug, in which they also consider explicit `this`
    // reads to be implicit. This causes problems when the explicit `this` read is inside a
    // template with a context that also provides the variable name being read:
    // ```
    // <ng-template let-a>{{this.a}}</ng-template>
    // ```
    // The whole point of the explicit `this` was to access the class property, but TDB and the
    // current TCB treat the read as implicit, and give you the context property instead!
    //
    // For now, we emulate this old behvaior by aggressively converting explicit reads to to
    // implicit reads, except for the special cases that TDB and the current TCB protect. However,
    // it would be an improvement to fix this.
    //
    // See also the corresponding comment for the TCB, in `type_check_block.ts`.
    if (isImplicitReceiver || (isThisReceiver && !isSpecialNode)) {
      return new ir.LexicalReadExpr(ast.name);
    } else {
      return new o.ReadPropExpr(
          convertAst(ast.receiver, job, baseSourceSpan), ast.name, null,
          convertSourceSpan(ast.span, baseSourceSpan));
    }
  } else if (ast instanceof e.PropertyWrite) {
    if (ast.receiver instanceof e.ImplicitReceiver) {
      return new o.WritePropExpr(
          // TODO: Is it correct to always use the root context in place of the implicit receiver?
          new ir.ContextExpr(job.root.xref), ast.name, convertAst(ast.value, job, baseSourceSpan),
          null, convertSourceSpan(ast.span, baseSourceSpan));
    }
    return new o.WritePropExpr(
        convertAst(ast.receiver, job, baseSourceSpan), ast.name,
        convertAst(ast.value, job, baseSourceSpan), undefined,
        convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.KeyedWrite) {
    return new o.WriteKeyExpr(
        convertAst(ast.receiver, job, baseSourceSpan), convertAst(ast.key, job, baseSourceSpan),
        convertAst(ast.value, job, baseSourceSpan), undefined,
        convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.Call) {
    if (ast.receiver instanceof e.ImplicitReceiver) {
      throw new Error(`Unexpected ImplicitReceiver`);
    } else {
      return new o.InvokeFunctionExpr(
          convertAst(ast.receiver, job, baseSourceSpan),
          ast.args.map(arg => convertAst(arg, job, baseSourceSpan)), undefined,
          convertSourceSpan(ast.span, baseSourceSpan));
    }
  } else if (ast instanceof e.LiteralPrimitive) {
    return o.literal(ast.value, undefined, convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.Unary) {
    switch (ast.operator) {
      case '+':
        return new o.UnaryOperatorExpr(
            o.UnaryOperator.Plus, convertAst(ast.expr, job, baseSourceSpan), undefined,
            convertSourceSpan(ast.span, baseSourceSpan));
      case '-':
        return new o.UnaryOperatorExpr(
            o.UnaryOperator.Minus, convertAst(ast.expr, job, baseSourceSpan), undefined,
            convertSourceSpan(ast.span, baseSourceSpan));
      default:
        throw new Error(`AssertionError: unknown unary operator ${ast.operator}`);
    }
  } else if (ast instanceof e.Binary) {
    const operator = BINARY_OPERATORS.get(ast.operation);
    if (operator === undefined) {
      throw new Error(`AssertionError: unknown binary operator ${ast.operation}`);
    }
    return new o.BinaryOperatorExpr(
        operator, convertAst(ast.left, job, baseSourceSpan),
        convertAst(ast.right, job, baseSourceSpan), undefined,
        convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.ThisReceiver) {
    // TODO: should context expressions have source maps?
    return new ir.ContextExpr(job.root.xref);
  } else if (ast instanceof e.KeyedRead) {
    return new o.ReadKeyExpr(
        convertAst(ast.receiver, job, baseSourceSpan), convertAst(ast.key, job, baseSourceSpan),
        undefined, convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.Chain) {
    throw new Error(`AssertionError: Chain in unknown context`);
  } else if (ast instanceof e.LiteralMap) {
    const entries = ast.keys.map((key, idx) => {
      const value = ast.values[idx];
      // TODO: should literals have source maps, or do we just map the whole surrounding
      // expression?
      return new o.LiteralMapEntry(key.key, convertAst(value, job, baseSourceSpan), key.quoted);
    });
    return new o.LiteralMapExpr(entries, undefined, convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.LiteralArray) {
    // TODO: should literals have source maps, or do we just map the whole surrounding expression?
    return new o.LiteralArrayExpr(
        ast.expressions.map(expr => convertAst(expr, job, baseSourceSpan)));
  } else if (ast instanceof e.Conditional) {
    return new o.ConditionalExpr(
        convertAst(ast.condition, job, baseSourceSpan),
        convertAst(ast.trueExp, job, baseSourceSpan), convertAst(ast.falseExp, job, baseSourceSpan),
        undefined, convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.NonNullAssert) {
    // A non-null assertion shouldn't impact generated instructions, so we can just drop it.
    return convertAst(ast.expression, job, baseSourceSpan);
  } else if (ast instanceof e.BindingPipe) {
    // TODO: pipes should probably have source maps; figure out details.
    return new ir.PipeBindingExpr(
        job.allocateXrefId(),
        new ir.SlotHandle(),
        ast.name,
        [
          convertAst(ast.exp, job, baseSourceSpan),
          ...ast.args.map(arg => convertAst(arg, job, baseSourceSpan)),
        ],
    );
  } else if (ast instanceof e.SafeKeyedRead) {
    return new ir.SafeKeyedReadExpr(
        convertAst(ast.receiver, job, baseSourceSpan), convertAst(ast.key, job, baseSourceSpan),
        convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.SafePropertyRead) {
    // TODO: source span
    return new ir.SafePropertyReadExpr(convertAst(ast.receiver, job, baseSourceSpan), ast.name);
  } else if (ast instanceof e.SafeCall) {
    // TODO: source span
    return new ir.SafeInvokeFunctionExpr(
        convertAst(ast.receiver, job, baseSourceSpan),
        ast.args.map(a => convertAst(a, job, baseSourceSpan)));
  } else if (ast instanceof e.EmptyExpr) {
    return new ir.EmptyExpr(convertSourceSpan(ast.span, baseSourceSpan));
  } else if (ast instanceof e.PrefixNot) {
    return o.not(
        convertAst(ast.expression, job, baseSourceSpan),
        convertSourceSpan(ast.span, baseSourceSpan));
  } else {
    throw new Error(`Unhandled expression type "${ast.constructor.name}" in file "${
        baseSourceSpan?.start.file.url}"`);
  }
}

function convertAstWithInterpolation(
    job: CompilationJob, value: e.AST|string, i18nMeta: i18n.I18nMeta|null|undefined,
    sourceSpan?: ParseSourceSpan): o.Expression|ir.Interpolation {
  let expression: o.Expression|ir.Interpolation;
  if (value instanceof e.Interpolation) {
    expression = new ir.Interpolation(
        value.strings, value.expressions.map(e => convertAst(e, job, sourceSpan ?? null)),
        Object.keys(asMessage(i18nMeta)?.placeholders ?? {}));
  } else if (value instanceof e.AST) {
    expression = convertAst(value, job, sourceSpan ?? null);
  } else {
    expression = o.literal(value);
  }
  return expression;
}

// TODO: Can we populate Template binding kinds in ingest?
const BINDING_KINDS = new Map<e.BindingType, ir.BindingKind>([
  [e.BindingType.Property, ir.BindingKind.Property],
  [e.BindingType.Attribute, ir.BindingKind.Attribute],
  [e.BindingType.Class, ir.BindingKind.ClassName],
  [e.BindingType.Style, ir.BindingKind.StyleProperty],
  [e.BindingType.Animation, ir.BindingKind.Animation],
]);

/**
 * Checks whether the given template is a plain ng-template (as opposed to another kind of template
 * such as a structural directive template or control flow template). This is checked based on the
 * tagName. We can expect that only plain ng-templates will come through with a tagName of
 * 'ng-template'.
 *
 * Here are some of the cases we expect:
 *
 * | Angular HTML                       | Template tagName   |
 * | ---------------------------------- | ------------------ |
 * | `<ng-template>`                    | 'ng-template'      |
 * | `<div *ngIf="true">`               | 'div'              |
 * | `<svg><ng-template>`               | 'svg:ng-template'  |
 * | `@if (true) {`                     | 'Conditional'      |
 * | `<ng-template *ngIf>` (plain)      | 'ng-template'      |
 * | `<ng-template *ngIf>` (structural) | null               |
 */
function isPlainTemplate(tmpl: t.Template) {
  return splitNsName(tmpl.tagName ?? '')[1] === NG_TEMPLATE_TAG_NAME;
}

/**
 * Ensures that the i18nMeta, if provided, is an i18n.Message.
 */
function asMessage(i18nMeta: i18n.I18nMeta|null|undefined): i18n.Message|null {
  if (i18nMeta == null) {
    return null;
  }
  if (!(i18nMeta instanceof i18n.Message)) {
    throw Error(`Expected i18n meta to be a Message, but got: ${i18nMeta.constructor.name}`);
  }
  return i18nMeta;
}

/**
 * Process all of the bindings on an element in the template AST and convert them to their IR
 * representation.
 */
function ingestElementBindings(
    unit: ViewCompilationUnit, op: ir.ElementOpBase, element: t.Element): void {
  let bindings = new Array<ir.BindingOp|ir.ExtractedAttributeOp|null>();

  for (const attr of element.attributes) {
    // Attribute literal bindings, such as `attr.foo="bar"`.
    const securityContext = domSchema.securityContext(element.name, attr.name, true);
    bindings.push(ir.createBindingOp(
        op.xref, ir.BindingKind.Attribute, attr.name,
        convertAstWithInterpolation(unit.job, attr.value, attr.i18n), null, securityContext, true,
        false, null, asMessage(attr.i18n), attr.sourceSpan));
  }

  for (const input of element.inputs) {
    // All dynamic bindings (both attribute and property bindings).
    bindings.push(ir.createBindingOp(
        op.xref, BINDING_KINDS.get(input.type)!, input.name,
        convertAstWithInterpolation(unit.job, astOf(input.value), input.i18n), input.unit,
        input.securityContext, false, false, null, asMessage(input.i18n) ?? null,
        input.sourceSpan));
  }

  unit.create.push(bindings.filter(
      (b): b is ir.ExtractedAttributeOp => b?.kind === ir.OpKind.ExtractedAttribute));
  unit.update.push(bindings.filter((b): b is ir.BindingOp => b?.kind === ir.OpKind.Binding));

  for (const output of element.outputs) {
    if (output.type === e.ParsedEventType.Animation && output.phase === null) {
      throw Error('Animation listener should have a phase');
    }

    unit.create.push(ir.createListenerOp(
        op.xref, op.handle, output.name, op.tag,
        makeListenerHandlerOps(unit, output.handler, output.handlerSpan), output.phase,
        output.target, false, output.sourceSpan));
  }

  // If any of the bindings on this element have an i18n message, then an i18n attrs configuration
  // op is also required.
  if (bindings.some(b => b?.i18nMessage) !== null) {
    unit.create.push(
        ir.createI18nAttributesOp(unit.job.allocateXrefId(), new ir.SlotHandle(), op.xref));
  }
}

/**
 * Process all of the bindings on a template in the template AST and convert them to their IR
 * representation.
 */
function ingestTemplateBindings(
    unit: ViewCompilationUnit, op: ir.ElementOpBase, template: t.Template,
    templateKind: ir.TemplateKind|null): void {
  let bindings = new Array<ir.BindingOp|ir.ExtractedAttributeOp|null>();

  for (const attr of template.templateAttrs) {
    if (attr instanceof t.TextAttribute) {
      const securityContext = domSchema.securityContext(NG_TEMPLATE_TAG_NAME, attr.name, true);
      bindings.push(createTemplateBinding(
          unit, op.xref, e.BindingType.Attribute, attr.name, attr.value, null, securityContext,
          true, templateKind, asMessage(attr.i18n), attr.sourceSpan));
    } else {
      bindings.push(createTemplateBinding(
          unit, op.xref, attr.type, attr.name, astOf(attr.value), attr.unit, attr.securityContext,
          true, templateKind, asMessage(attr.i18n), attr.sourceSpan));
    }
  }

  for (const attr of template.attributes) {
    // Attribute literal bindings, such as `attr.foo="bar"`.
    const securityContext = domSchema.securityContext(NG_TEMPLATE_TAG_NAME, attr.name, true);
    bindings.push(createTemplateBinding(
        unit, op.xref, e.BindingType.Attribute, attr.name, attr.value, null, securityContext, false,
        templateKind, asMessage(attr.i18n), attr.sourceSpan));
  }

  for (const input of template.inputs) {
    // Dynamic bindings (both attribute and property bindings).
    bindings.push(createTemplateBinding(
        unit, op.xref, input.type, input.name, astOf(input.value), input.unit,
        input.securityContext, false, templateKind, asMessage(input.i18n), input.sourceSpan));
  }

  unit.create.push(bindings.filter(
      (b): b is ir.ExtractedAttributeOp => b?.kind === ir.OpKind.ExtractedAttribute));
  unit.update.push(bindings.filter((b): b is ir.BindingOp => b?.kind === ir.OpKind.Binding));

  for (const output of template.outputs) {
    if (output.type === e.ParsedEventType.Animation && output.phase === null) {
      throw Error('Animation listener should have a phase');
    }

    if (templateKind === ir.TemplateKind.NgTemplate) {
      unit.create.push(ir.createListenerOp(
          op.xref, op.handle, output.name, op.tag,
          makeListenerHandlerOps(unit, output.handler, output.handlerSpan), output.phase,
          output.target, false, output.sourceSpan));
    }
    if (templateKind === ir.TemplateKind.Structural &&
        output.type !== e.ParsedEventType.Animation) {
      // Animation bindings are excluded from the structural template's const array.
      const securityContext = domSchema.securityContext(NG_TEMPLATE_TAG_NAME, output.name, false);
      unit.create.push(ir.createExtractedAttributeOp(
          op.xref, ir.BindingKind.Property, null, output.name, null, null, null, securityContext));
    }
  }

  // TODO: Perhaps we could do this in a phase? (It likely wouldn't change the slot indices.)
  if (bindings.some(b => b?.i18nMessage) !== null) {
    unit.create.push(
        ir.createI18nAttributesOp(unit.job.allocateXrefId(), new ir.SlotHandle(), op.xref));
  }
}

/**
 * Helper to ingest an individual binding on a template, either an explicit `ng-template`, or an
 * implicit template created via structural directive.
 *
 * Bindings on templates are *extremely* tricky. I have tried to isolate all of the confusing edge
 * cases into this function, and to comment it well to document the behavior.
 *
 * Some of this behavior is intuitively incorrect, and we should consider changing it in the future.
 *
 * @param view The compilation unit for the view containing the template.
 * @param xref The xref of the template op.
 * @param type The binding type, according to the parser. This is fairly reasonable, e.g. both
 *     dynamic and static attributes have e.BindingType.Attribute.
 * @param name The binding's name.
 * @param value The bindings's value, which will either be an input AST expression, or a string
 *     literal. Note that the input AST expression may or may not be const -- it will only be a
 *     string literal if the parser considered it a text binding.
 * @param unit If the binding has a unit (e.g. `px` for style bindings), then this is the unit.
 * @param securityContext The security context of the binding.
 * @param isStructuralTemplateAttribute Whether this binding actually applies to the structural
 *     ng-template. For example, an `ngFor` would actually apply to the structural template. (Most
 *     bindings on structural elements target the inner element, not the template.)
 * @param templateKind Whether this is an explicit `ng-template` or an implicit template created by
 *     a structural directive. This should never be a block template.
 * @param i18nMessage The i18n metadata for the binding, if any.
 * @param sourceSpan The source span of the binding.
 * @returns An IR binding op, or null if the binding should be skipped.
 */
function createTemplateBinding(
    view: ViewCompilationUnit, xref: ir.XrefId, type: e.BindingType, name: string,
    value: e.AST|string, unit: string|null, securityContext: SecurityContext,
    isStructuralTemplateAttribute: boolean, templateKind: ir.TemplateKind|null,
    i18nMessage: i18n.Message|null, sourceSpan: ParseSourceSpan): ir.BindingOp|
    ir.ExtractedAttributeOp|null {
  const isTextBinding = typeof value === 'string';
  // If this is a structural template, then several kinds of bindings should not result in an
  // update instruction.
  if (templateKind === ir.TemplateKind.Structural) {
    if (!isStructuralTemplateAttribute &&
        (type === e.BindingType.Property || type === e.BindingType.Class ||
         type === e.BindingType.Style)) {
      // Because this binding doesn't really target the ng-template, it must be a binding on an
      // inner node of a structural template. We can't skip it entirely, because we still need it on
      // the ng-template's consts (e.g. for the purposes of directive matching). However, we should
      // not generate an update instruction for it.
      return ir.createExtractedAttributeOp(
          xref, ir.BindingKind.Property, null, name, null, null, i18nMessage, securityContext);
    }

    if (!isTextBinding && (type === e.BindingType.Attribute || type === e.BindingType.Animation)) {
      // Again, this binding doesn't really target the ng-template; it actually targets the element
      // inside the structural template. In the case of non-text attribute or animation bindings,
      // the binding doesn't even show up on the ng-template const array, so we just skip it
      // entirely.
      return null;
    }
  }

  let bindingType = BINDING_KINDS.get(type)!;

  if (templateKind === ir.TemplateKind.NgTemplate) {
    // We know we are dealing with bindings directly on an explicit ng-template.
    // Static attribute bindings should be collected into the const array as k/v pairs. Property
    // bindings should result in a `property` instruction, and `AttributeMarker.Bindings` const
    // entries.
    //
    // The difficulty is with dynamic attribute, style, and class bindings. These don't really make
    // sense on an `ng-template` and should probably be parser errors. However,
    // TemplateDefinitionBuilder generates `property` instructions for them, and so we do that as
    // well.
    //
    // Note that we do have a slight behavior difference with TemplateDefinitionBuilder: although
    // TDB emits `property` instructions for dynamic attributes, styles, and classes, only styles
    // and classes also get const collected into the `AttributeMarker.Bindings` field. Dynamic
    // attribute bindings are missing from the consts entirely. We choose to emit them into the
    // consts field anyway, to avoid creating special cases for something so arcane and nonsensical.
    if (type === e.BindingType.Class || type === e.BindingType.Style ||
        (type === e.BindingType.Attribute && !isTextBinding)) {
      // TODO: These cases should be parse errors.
      bindingType = ir.BindingKind.Property;
    }
  }

  return ir.createBindingOp(
      xref, bindingType, name, convertAstWithInterpolation(view.job, value, i18nMessage), unit,
      securityContext, isTextBinding, isStructuralTemplateAttribute, templateKind, i18nMessage,
      sourceSpan);
}

function makeListenerHandlerOps(
    unit: CompilationUnit, handler: e.AST, handlerSpan: ParseSourceSpan): ir.UpdateOp[] {
  handler = astOf(handler);
  const handlerOps = new Array<ir.UpdateOp>();
  let handlerExprs: e.AST[] = handler instanceof e.Chain ? handler.expressions : [handler];
  if (handlerExprs.length === 0) {
    throw new Error('Expected listener to have non-empty expression list.');
  }
  const expressions = handlerExprs.map(expr => convertAst(expr, unit.job, handlerSpan));
  const returnExpr = expressions.pop()!;
  handlerOps.push(...expressions.map(
      e => ir.createStatementOp<ir.UpdateOp>(new o.ExpressionStatement(e, e.sourceSpan))));
  handlerOps.push(ir.createStatementOp(new o.ReturnStatement(returnExpr, returnExpr.sourceSpan)));
  return handlerOps;
}

function astOf(ast: e.AST|e.ASTWithSource): e.AST {
  return ast instanceof e.ASTWithSource ? ast.ast : ast;
}

/**
 * Process all of the local references on an element-like structure in the template AST and
 * convert them to their IR representation.
 */
function ingestReferences(op: ir.ElementOpBase, element: t.Element|t.Template): void {
  assertIsArray<ir.LocalRef>(op.localRefs);
  for (const {name, value} of element.references) {
    op.localRefs.push({
      name,
      target: value,
    });
  }
}

/**
 * Assert that the given value is an array.
 */
function assertIsArray<T>(value: any): asserts value is Array<T> {
  if (!Array.isArray(value)) {
    throw new Error(`AssertionError: expected an array`);
  }
}

/**
 * Creates an absolute `ParseSourceSpan` from the relative `ParseSpan`.
 *
 * `ParseSpan` objects are relative to the start of the expression.
 * This method converts these to full `ParseSourceSpan` objects that
 * show where the span is within the overall source file.
 *
 * @param span the relative span to convert.
 * @param baseSourceSpan a span corresponding to the base of the expression tree.
 * @returns a `ParseSourceSpan` for the given span or null if no `baseSourceSpan` was provided.
 */
function convertSourceSpan(
    span: e.ParseSpan, baseSourceSpan: ParseSourceSpan|null): ParseSourceSpan|null {
  if (baseSourceSpan === null) {
    return null;
  }
  const start = baseSourceSpan.start.moveBy(span.start);
  const end = baseSourceSpan.start.moveBy(span.end);
  const fullStart = baseSourceSpan.fullStart.moveBy(span.start);
  return new ParseSourceSpan(start, end, fullStart);
}

/**
 * With the directive-based control flow users were able to conditionally project content using
 * the `*` syntax. E.g. `<div *ngIf="expr" projectMe></div>` will be projected into
 * `<ng-content select="[projectMe]"/>`, because the attributes and tag name from the `div` are
 * copied to the template via the template creation instruction. With `@if` and `@for` that is
 * not the case, because the conditional is placed *around* elements, rather than *on* them.
 * The result is that content projection won't work in the same way if a user converts from
 * `*ngIf` to `@if`.
 *
 * This function aims to cover the most common case by doing the same copying when a control flow
 * node has *one and only one* root element or template node.
 *
 * This approach comes with some caveats:
 * 1. As soon as any other node is added to the root, the copying behavior won't work anymore.
 *    A diagnostic will be added to flag cases like this and to explain how to work around it.
 * 2. If `preserveWhitespaces` is enabled, it's very likely that indentation will break this
 *    workaround, because it'll include an additional text node as the first child. We can work
 *    around it here, but in a discussion it was decided not to, because the user explicitly opted
 *    into preserving the whitespace and we would have to drop it from the generated code.
 *    The diagnostic mentioned point #1 will flag such cases to users.
 *
 * @returns Tag name to be used for the control flow template.
 */
function ingestControlFlowInsertionPoint(
    unit: ViewCompilationUnit, xref: ir.XrefId,
    node: t.IfBlockBranch|t.ForLoopBlock|t.ForLoopBlockEmpty): string|null {
  let root: t.Element|t.Template|null = null;

  for (const child of node.children) {
    // Skip over comment nodes.
    if (child instanceof t.Comment) {
      continue;
    }

    // We can only infer the tag name/attributes if there's a single root node.
    if (root !== null) {
      return null;
    }

    // Root nodes can only elements or templates with a tag name (e.g. `<div *foo></div>`).
    if (child instanceof t.Element || (child instanceof t.Template && child.tagName !== null)) {
      root = child;
    }
  }

  // If we've found a single root node, its tag name and *static* attributes can be copied
  // to the surrounding template to be used for content projection. Note that it's important
  // that we don't copy any bound attributes since they don't participate in content projection
  // and they can be used in directive matching (in the case of `Template.templateAttrs`).
  if (root !== null) {
    for (const attr of root.attributes) {
      const securityContext = domSchema.securityContext(NG_TEMPLATE_TAG_NAME, attr.name, true);
      unit.update.push(ir.createBindingOp(
          xref, ir.BindingKind.Attribute, attr.name, o.literal(attr.value), null, securityContext,
          true, false, null, asMessage(attr.i18n), attr.sourceSpan));
    }

    const tagName = root instanceof t.Element ? root.name : root.tagName;

    // Don't pass along `ng-template` tag name since it enables directive matching.
    return tagName === NG_TEMPLATE_TAG_NAME ? null : tagName;
  }

  return null;
}
