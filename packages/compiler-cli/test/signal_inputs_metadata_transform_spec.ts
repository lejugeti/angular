/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import ts from 'typescript';

import {TypeScriptReflectionHost} from '../src/ngtsc/reflection';
import {getDownlevelDecoratorsTransform, getInputSignalsMetadataTransform} from '../src/transformers/jit_transforms';

import {MockAotContext, MockCompilerHost} from './mocks';

const TEST_FILE_INPUT = '/test.ts';
const TEST_FILE_OUTPUT = `/test.js`;

describe('signal inputs metadata transform', () => {
  let host: MockCompilerHost;
  let context: MockAotContext;

  beforeEach(() => {
    context = new MockAotContext('/', {
      'core.d.ts': `
        export declare const Directive: any;
        export declare const Input: any;
        export declare const input: any;
      `,
    });
    host = new MockCompilerHost(context);
  });

  function transform(contents: string, postDownlevelDecoratorsTransform = false) {
    context.writeFile(TEST_FILE_INPUT, contents);

    const program = ts.createProgram(
        [TEST_FILE_INPUT], {
          module: ts.ModuleKind.ESNext,
          lib: ['dom', 'es2022'],
          target: ts.ScriptTarget.ES2022,
          traceResolution: true,
          experimentalDecorators: true,
          paths: {
            '@angular/core': ['./core.d.ts'],
          },
        },
        host);

    const testFile = program.getSourceFile(TEST_FILE_INPUT);
    const typeChecker = program.getTypeChecker();
    const reflectionHost = new TypeScriptReflectionHost(typeChecker);
    const transformers: ts.CustomTransformers = {
      before: [
        getInputSignalsMetadataTransform(reflectionHost, /* isCore */ false),
      ]
    };

    if (postDownlevelDecoratorsTransform) {
      transformers.before!.push(getDownlevelDecoratorsTransform(
          typeChecker, reflectionHost, [], /* isCore */ false,
          /* isClosureCompilerEnabled */ false));
    }

    let output: string|null = null;
    const emitResult = program.emit(
        testFile, ((fileName, outputText) => {
          if (fileName === TEST_FILE_OUTPUT) {
            output = outputText;
          }
        }),
        undefined, undefined, transformers);

    expect(emitResult.diagnostics.length).toBe(0);
    expect(output).not.toBeNull();

    return omitLeadingWhitespace(output!);
  }

  it('should add `@Input` decorator for a signal input', () => {
    const result = transform(`
      import {input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input(0);
      }
    `);

    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput", required: false, transform: undefined })
        ], MyDir.prototype, "someInput", void 0);
    `));
  });

  it('should add `@Input` decorator for a required signal input', () => {
    const result = transform(`
      import {input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input.required<string>();
      }
    `);

    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput", required: true, transform: undefined })
        ], MyDir.prototype, "someInput", void 0);
    `));
  });

  it('should add `@Input` decorator for signal inputs with alias options', () => {
    const result = transform(`
      import {input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input(null, {alias: "public1"});
        someInput2 = input.required<string>({alias: "public2"});
      }
    `);

    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "public1", required: false, transform: undefined })
        ], MyDir.prototype, "someInput", void 0);
      __decorate([
        i0.Input({ isSignal: true, alias: "public2", required: true, transform: undefined })
        ], MyDir.prototype, "someInput2", void 0);
    `));
  });

  it('should add `@Input` decorator for signal inputs with transforms', () => {
    const result = transform(`
      import {input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input(0, {transform: v => v + 1});
        someInput2 = input.required<number>({transform: v => v + 1});
      }
    `);

    // Transform functions are never captured because the input signal already captures
    // them and will run these independently of whether a `transform` is specified here.
    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput", required: false, transform: undefined })
        ], MyDir.prototype, "someInput", void 0);
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput2", required: true, transform: undefined })
        ], MyDir.prototype, "someInput2", void 0);
    `));
  });

  it('should not transform `@Input` decorator for non-signal inputs', () => {
    const result = transform(`
      import {Input, input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input.required<string>({});
        @Input({someOptionIndicatingThatNothingChanged: true}) nonSignalInput: number = 0;
      }
    `);

    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput", required: true, transform: undefined })
        ], MyDir.prototype, "someInput", void 0);
      __decorate([
        Input({ someOptionIndicatingThatNothingChanged: true })
        ], MyDir.prototype, "nonSignalInput", void 0);
    `));
  });

  it('should not transform signal inputs with an existing `@Input` decorator', () => {
    // This is expected to not happen because technically the TS code for signal inputs
    // should never discover both `@Input` and signal inputs. We handle this gracefully
    // though in case someone compiles without the Angular compiler (which would report a
    // diagnostic).
    const result = transform(`
        import {Input, input, Directive} from '@angular/core';

        @Directive({})
        class MyDir {
          @Input() someInput = input.required<string>({});
        }
      `);

    expect(result).toContain(omitLeadingWhitespace(`
        __decorate([
          Input()
          ], MyDir.prototype, "someInput", void 0);
      `));
  });

  it('should preserve existing decorators applied on signal inputs fields', () => {
    const result = transform(`
        import {Input, input, Directive} from '@angular/core';

        declare const MyCustomDecorator: any;

        @Directive({})
        class MyDir {
          @MyCustomDecorator() someInput = input.required<string>({});
        }
      `);

    expect(result).toContain(omitLeadingWhitespace(`
      __decorate([
        i0.Input({ isSignal: true, alias: "someInput", required: true, transform: undefined }),
        MyCustomDecorator()
        ], MyDir.prototype, "someInput", void 0);
      `));
  });

  it('should work with decorator downleveling post-transform', () => {
    const result = transform(
        `
      import {input, Directive} from '@angular/core';

      @Directive({})
      class MyDir {
        someInput = input(0);
      }
    `,
        /* postDownlevelDecoratorsTransform */ true);

    expect(result).toContain(omitLeadingWhitespace(`
      static propDecorators = {
        someInput: [{ type: i0.Input, args: [{ isSignal: true, alias: "someInput", required: false, transform: undefined },] }]
      };
    `));
  });
});

/** Omits the leading whitespace for each line of the given text. */
function omitLeadingWhitespace(text: string): string {
  return text.replace(/^\s+/gm, '');
}
