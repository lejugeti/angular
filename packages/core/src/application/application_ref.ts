/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import '../util/ng_jit_mode';

import {setThrowInvalidWriteToSignalError} from '@angular/core/primitives/signals';
import {Observable} from 'rxjs';
import {first, map} from 'rxjs/operators';

import {getCompilerFacade, JitCompilerUsage} from '../compiler/compiler_facade';
import {Console} from '../console';
import {inject} from '../di';
import {Injectable} from '../di/injectable';
import {InjectionToken} from '../di/injection_token';
import {Injector} from '../di/injector';
import {EnvironmentInjector} from '../di/r3_injector';
import {ErrorHandler, INTERNAL_APPLICATION_ERROR_HANDLER} from '../error_handler';
import {formatRuntimeError, RuntimeError, RuntimeErrorCode} from '../errors';
import {Type} from '../interface/type';
import {COMPILER_OPTIONS, CompilerOptions} from '../linker/compiler';
import {ComponentFactory, ComponentRef} from '../linker/component_factory';
import {ComponentFactoryResolver} from '../linker/component_factory_resolver';
import {NgModuleFactory, NgModuleRef} from '../linker/ng_module_factory';
import {ViewRef} from '../linker/view_ref';
import {isComponentResourceResolutionQueueEmpty, resolveComponentResources} from '../metadata/resource_loading';
import {PendingTasks} from '../pending_tasks';
import {AfterRenderEventManager} from '../render3/after_render_hooks';
import {assertNgModuleType} from '../render3/assert';
import {ComponentFactory as R3ComponentFactory} from '../render3/component_ref';
import {isStandalone} from '../render3/definition';
import {setJitOptions} from '../render3/jit/jit_options';
import {NgModuleFactory as R3NgModuleFactory} from '../render3/ng_module_ref';
import {publishDefaultGlobalUtils as _publishDefaultGlobalUtils} from '../render3/util/global_utils';
import {ViewRef as InternalViewRef} from '../render3/view_ref';
import {TESTABILITY} from '../testability/testability';
import {isPromise} from '../util/lang';
import {NgZone} from '../zone/ng_zone';

import {ApplicationInitStatus} from './application_init';

/**
 * A [DI token](guide/glossary#di-token "DI token definition") that provides a set of callbacks to
 * be called for every component that is bootstrapped.
 *
 * Each callback must take a `ComponentRef` instance and return nothing.
 *
 * `(componentRef: ComponentRef) => void`
 *
 * @publicApi
 */
export const APP_BOOTSTRAP_LISTENER =
    new InjectionToken<ReadonlyArray<(compRef: ComponentRef<any>) => void>>('appBootstrapListener');

export function compileNgModuleFactory<M>(
    injector: Injector, options: CompilerOptions,
    moduleType: Type<M>): Promise<NgModuleFactory<M>> {
  ngDevMode && assertNgModuleType(moduleType);

  const moduleFactory = new R3NgModuleFactory(moduleType);

  // All of the logic below is irrelevant for AOT-compiled code.
  if (typeof ngJitMode !== 'undefined' && !ngJitMode) {
    return Promise.resolve(moduleFactory);
  }

  const compilerOptions = injector.get(COMPILER_OPTIONS, []).concat(options);

  // Configure the compiler to use the provided options. This call may fail when multiple modules
  // are bootstrapped with incompatible options, as a component can only be compiled according to
  // a single set of options.
  setJitOptions({
    defaultEncapsulation: _lastDefined(compilerOptions.map(opts => opts.defaultEncapsulation)),
    preserveWhitespaces: _lastDefined(compilerOptions.map(opts => opts.preserveWhitespaces)),
  });

  if (isComponentResourceResolutionQueueEmpty()) {
    return Promise.resolve(moduleFactory);
  }

  const compilerProviders = compilerOptions.flatMap((option) => option.providers ?? []);

  // In case there are no compiler providers, we just return the module factory as
  // there won't be any resource loader. This can happen with Ivy, because AOT compiled
  // modules can be still passed through "bootstrapModule". In that case we shouldn't
  // unnecessarily require the JIT compiler.
  if (compilerProviders.length === 0) {
    return Promise.resolve(moduleFactory);
  }

  const compiler = getCompilerFacade({
    usage: JitCompilerUsage.Decorator,
    kind: 'NgModule',
    type: moduleType,
  });
  const compilerInjector = Injector.create({providers: compilerProviders});
  const resourceLoader = compilerInjector.get(compiler.ResourceLoader);
  // The resource loader can also return a string while the "resolveComponentResources"
  // always expects a promise. Therefore we need to wrap the returned value in a promise.
  return resolveComponentResources(url => Promise.resolve(resourceLoader.get(url)))
      .then(() => moduleFactory);
}

export function publishDefaultGlobalUtils() {
  ngDevMode && _publishDefaultGlobalUtils();
}

/**
 * Sets the error for an invalid write to a signal to be an Angular `RuntimeError`.
 */
export function publishSignalConfiguration(): void {
  setThrowInvalidWriteToSignalError(() => {
    throw new RuntimeError(
        RuntimeErrorCode.SIGNAL_WRITE_FROM_ILLEGAL_CONTEXT,
        ngDevMode &&
            'Writing to signals is not allowed in a `computed` or an `effect` by default. ' +
                'Use `allowSignalWrites` in the `CreateEffectOptions` to enable this inside effects.');
  });
}

export function isBoundToModule<C>(cf: ComponentFactory<C>): boolean {
  return (cf as R3ComponentFactory<C>).isBoundToModule;
}

/**
 * A token for third-party components that can register themselves with NgProbe.
 *
 * @deprecated
 * @publicApi
 */
export class NgProbeToken {
  constructor(public name: string, public token: any) {}
}

/**
 * Provides additional options to the bootstrapping process.
 *
 * @publicApi
 */
export interface BootstrapOptions {
  /**
   * Optionally specify which `NgZone` should be used.
   *
   * - Provide your own `NgZone` instance.
   * - `zone.js` - Use default `NgZone` which requires `Zone.js`.
   * - `noop` - Use `NoopNgZone` which does nothing.
   */
  ngZone?: NgZone|'zone.js'|'noop';

  /**
   * Optionally specify coalescing event change detections or not.
   * Consider the following case.
   *
   * ```
   * <div (click)="doSomething()">
   *   <button (click)="doSomethingElse()"></button>
   * </div>
   * ```
   *
   * When button is clicked, because of the event bubbling, both
   * event handlers will be called and 2 change detections will be
   * triggered. We can coalesce such kind of events to only trigger
   * change detection only once.
   *
   * By default, this option will be false. So the events will not be
   * coalesced and the change detection will be triggered multiple times.
   * And if this option be set to true, the change detection will be
   * triggered async by scheduling a animation frame. So in the case above,
   * the change detection will only be triggered once.
   */
  ngZoneEventCoalescing?: boolean;

  /**
   * Optionally specify if `NgZone#run()` method invocations should be coalesced
   * into a single change detection.
   *
   * Consider the following case.
   * ```
   * for (let i = 0; i < 10; i ++) {
   *   ngZone.run(() => {
   *     // do something
   *   });
   * }
   * ```
   *
   * This case triggers the change detection multiple times.
   * With ngZoneRunCoalescing options, all change detections in an event loop trigger only once.
   * In addition, the change detection executes in requestAnimation.
   *
   */
  ngZoneRunCoalescing?: boolean;
}

export function _callAndReportToErrorHandler(
    errorHandler: ErrorHandler, ngZone: NgZone, callback: () => any): any {
  try {
    const result = callback();
    if (isPromise(result)) {
      return result.catch((e: any) => {
        ngZone.runOutsideAngular(() => errorHandler.handleError(e));
        // rethrow as the exception handler might not do it
        throw e;
      });
    }

    return result;
  } catch (e) {
    ngZone.runOutsideAngular(() => errorHandler.handleError(e));
    // rethrow as the exception handler might not do it
    throw e;
  }
}

export function optionsReducer<T extends Object>(dst: T, objs: T|T[]): T {
  if (Array.isArray(objs)) {
    return objs.reduce(optionsReducer, dst);
  }
  return {...dst, ...objs};
}

/**
 * A reference to an Angular application running on a page.
 *
 * @usageNotes
 * {@a is-stable-examples}
 * ### isStable examples and caveats
 *
 * Note two important points about `isStable`, demonstrated in the examples below:
 * - the application will never be stable if you start any kind
 * of recurrent asynchronous task when the application starts
 * (for example for a polling process, started with a `setInterval`, a `setTimeout`
 * or using RxJS operators like `interval`);
 * - the `isStable` Observable runs outside of the Angular zone.
 *
 * Let's imagine that you start a recurrent task
 * (here incrementing a counter, using RxJS `interval`),
 * and at the same time subscribe to `isStable`.
 *
 * ```
 * constructor(appRef: ApplicationRef) {
 *   appRef.isStable.pipe(
 *      filter(stable => stable)
 *   ).subscribe(() => console.log('App is stable now');
 *   interval(1000).subscribe(counter => console.log(counter));
 * }
 * ```
 * In this example, `isStable` will never emit `true`,
 * and the trace "App is stable now" will never get logged.
 *
 * If you want to execute something when the app is stable,
 * you have to wait for the application to be stable
 * before starting your polling process.
 *
 * ```
 * constructor(appRef: ApplicationRef) {
 *   appRef.isStable.pipe(
 *     first(stable => stable),
 *     tap(stable => console.log('App is stable now')),
 *     switchMap(() => interval(1000))
 *   ).subscribe(counter => console.log(counter));
 * }
 * ```
 * In this example, the trace "App is stable now" will be logged
 * and then the counter starts incrementing every second.
 *
 * Note also that this Observable runs outside of the Angular zone,
 * which means that the code in the subscription
 * to this Observable will not trigger the change detection.
 *
 * Let's imagine that instead of logging the counter value,
 * you update a field of your component
 * and display it in its template.
 *
 * ```
 * constructor(appRef: ApplicationRef) {
 *   appRef.isStable.pipe(
 *     first(stable => stable),
 *     switchMap(() => interval(1000))
 *   ).subscribe(counter => this.value = counter);
 * }
 * ```
 * As the `isStable` Observable runs outside the zone,
 * the `value` field will be updated properly,
 * but the template will not be refreshed!
 *
 * You'll have to manually trigger the change detection to update the template.
 *
 * ```
 * constructor(appRef: ApplicationRef, cd: ChangeDetectorRef) {
 *   appRef.isStable.pipe(
 *     first(stable => stable),
 *     switchMap(() => interval(1000))
 *   ).subscribe(counter => {
 *     this.value = counter;
 *     cd.detectChanges();
 *   });
 * }
 * ```
 *
 * Or make the subscription callback run inside the zone.
 *
 * ```
 * constructor(appRef: ApplicationRef, zone: NgZone) {
 *   appRef.isStable.pipe(
 *     first(stable => stable),
 *     switchMap(() => interval(1000))
 *   ).subscribe(counter => zone.run(() => this.value = counter));
 * }
 * ```
 *
 * @publicApi
 */
@Injectable({providedIn: 'root'})
export class ApplicationRef {
  /** @internal */
  private _bootstrapListeners: ((compRef: ComponentRef<any>) => void)[] = [];
  private _runningTick: boolean = false;
  private _destroyed = false;
  private _destroyListeners: Array<() => void> = [];
  /** @internal */
  _views: InternalViewRef<unknown>[] = [];
  private readonly internalErrorHandler = inject(INTERNAL_APPLICATION_ERROR_HANDLER);
  private readonly afterRenderEffectManager = inject(AfterRenderEventManager);

  /**
   * Indicates whether this instance was destroyed.
   */
  get destroyed() {
    return this._destroyed;
  }

  /**
   * Get a list of component types registered to this application.
   * This list is populated even before the component is created.
   */
  public readonly componentTypes: Type<any>[] = [];

  /**
   * Get a list of components registered to this application.
   */
  public readonly components: ComponentRef<any>[] = [];

  /**
   * Returns an Observable that indicates when the application is stable or unstable.
   */
  public readonly isStable: Observable<boolean> =
      inject(PendingTasks).hasPendingTasks.pipe(map(pending => !pending));

  private readonly _injector = inject(EnvironmentInjector);
  /**
   * The `EnvironmentInjector` used to create this application.
   */
  get injector(): EnvironmentInjector {
    return this._injector;
  }

  /**
   * Bootstrap a component onto the element identified by its selector or, optionally, to a
   * specified element.
   *
   * @usageNotes
   * ### Bootstrap process
   *
   * When bootstrapping a component, Angular mounts it onto a target DOM element
   * and kicks off automatic change detection. The target DOM element can be
   * provided using the `rootSelectorOrNode` argument.
   *
   * If the target DOM element is not provided, Angular tries to find one on a page
   * using the `selector` of the component that is being bootstrapped
   * (first matched element is used).
   *
   * ### Example
   *
   * Generally, we define the component to bootstrap in the `bootstrap` array of `NgModule`,
   * but it requires us to know the component while writing the application code.
   *
   * Imagine a situation where we have to wait for an API call to decide about the component to
   * bootstrap. We can use the `ngDoBootstrap` hook of the `NgModule` and call this method to
   * dynamically bootstrap a component.
   *
   * {@example core/ts/platform/platform.ts region='componentSelector'}
   *
   * Optionally, a component can be mounted onto a DOM element that does not match the
   * selector of the bootstrapped component.
   *
   * In the following example, we are providing a CSS selector to match the target element.
   *
   * {@example core/ts/platform/platform.ts region='cssSelector'}
   *
   * While in this example, we are providing reference to a DOM node.
   *
   * {@example core/ts/platform/platform.ts region='domNode'}
   */
  bootstrap<C>(component: Type<C>, rootSelectorOrNode?: string|any): ComponentRef<C>;

  /**
   * Bootstrap a component onto the element identified by its selector or, optionally, to a
   * specified element.
   *
   * @usageNotes
   * ### Bootstrap process
   *
   * When bootstrapping a component, Angular mounts it onto a target DOM element
   * and kicks off automatic change detection. The target DOM element can be
   * provided using the `rootSelectorOrNode` argument.
   *
   * If the target DOM element is not provided, Angular tries to find one on a page
   * using the `selector` of the component that is being bootstrapped
   * (first matched element is used).
   *
   * ### Example
   *
   * Generally, we define the component to bootstrap in the `bootstrap` array of `NgModule`,
   * but it requires us to know the component while writing the application code.
   *
   * Imagine a situation where we have to wait for an API call to decide about the component to
   * bootstrap. We can use the `ngDoBootstrap` hook of the `NgModule` and call this method to
   * dynamically bootstrap a component.
   *
   * {@example core/ts/platform/platform.ts region='componentSelector'}
   *
   * Optionally, a component can be mounted onto a DOM element that does not match the
   * selector of the bootstrapped component.
   *
   * In the following example, we are providing a CSS selector to match the target element.
   *
   * {@example core/ts/platform/platform.ts region='cssSelector'}
   *
   * While in this example, we are providing reference to a DOM node.
   *
   * {@example core/ts/platform/platform.ts region='domNode'}
   *
   * @deprecated Passing Component factories as the `Application.bootstrap` function argument is
   *     deprecated. Pass Component Types instead.
   */
  bootstrap<C>(componentFactory: ComponentFactory<C>, rootSelectorOrNode?: string|any):
      ComponentRef<C>;

  /**
   * Bootstrap a component onto the element identified by its selector or, optionally, to a
   * specified element.
   *
   * @usageNotes
   * ### Bootstrap process
   *
   * When bootstrapping a component, Angular mounts it onto a target DOM element
   * and kicks off automatic change detection. The target DOM element can be
   * provided using the `rootSelectorOrNode` argument.
   *
   * If the target DOM element is not provided, Angular tries to find one on a page
   * using the `selector` of the component that is being bootstrapped
   * (first matched element is used).
   *
   * ### Example
   *
   * Generally, we define the component to bootstrap in the `bootstrap` array of `NgModule`,
   * but it requires us to know the component while writing the application code.
   *
   * Imagine a situation where we have to wait for an API call to decide about the component to
   * bootstrap. We can use the `ngDoBootstrap` hook of the `NgModule` and call this method to
   * dynamically bootstrap a component.
   *
   * {@example core/ts/platform/platform.ts region='componentSelector'}
   *
   * Optionally, a component can be mounted onto a DOM element that does not match the
   * selector of the bootstrapped component.
   *
   * In the following example, we are providing a CSS selector to match the target element.
   *
   * {@example core/ts/platform/platform.ts region='cssSelector'}
   *
   * While in this example, we are providing reference to a DOM node.
   *
   * {@example core/ts/platform/platform.ts region='domNode'}
   */
  bootstrap<C>(componentOrFactory: ComponentFactory<C>|Type<C>, rootSelectorOrNode?: string|any):
      ComponentRef<C> {
    (typeof ngDevMode === 'undefined' || ngDevMode) && this.warnIfDestroyed();
    const isComponentFactory = componentOrFactory instanceof ComponentFactory;
    const initStatus = this._injector.get(ApplicationInitStatus);

    if (!initStatus.done) {
      const standalone = !isComponentFactory && isStandalone(componentOrFactory);
      const errorMessage = (typeof ngDevMode === 'undefined' || ngDevMode) &&
          'Cannot bootstrap as there are still asynchronous initializers running.' +
              (standalone ?
                   '' :
                   ' Bootstrap components in the `ngDoBootstrap` method of the root module.');
      throw new RuntimeError(RuntimeErrorCode.ASYNC_INITIALIZERS_STILL_RUNNING, errorMessage);
    }

    let componentFactory: ComponentFactory<C>;
    if (isComponentFactory) {
      componentFactory = componentOrFactory;
    } else {
      const resolver = this._injector.get(ComponentFactoryResolver);
      componentFactory = resolver.resolveComponentFactory(componentOrFactory)!;
    }
    this.componentTypes.push(componentFactory.componentType);

    // Create a factory associated with the current module if it's not bound to some other
    const ngModule =
        isBoundToModule(componentFactory) ? undefined : this._injector.get(NgModuleRef);
    const selectorOrNode = rootSelectorOrNode || componentFactory.selector;
    const compRef = componentFactory.create(Injector.NULL, [], selectorOrNode, ngModule);
    const nativeElement = compRef.location.nativeElement;
    const testability = compRef.injector.get(TESTABILITY, null);
    testability?.registerApplication(nativeElement);

    compRef.onDestroy(() => {
      this.detachView(compRef.hostView);
      remove(this.components, compRef);
      testability?.unregisterApplication(nativeElement);
    });

    this._loadComponent(compRef);
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      const _console = this._injector.get(Console);
      _console.log(`Angular is running in development mode.`);
    }
    return compRef;
  }

  /**
   * Invoke this method to explicitly process change detection and its side-effects.
   *
   * In development mode, `tick()` also performs a second change detection cycle to ensure that no
   * further changes are detected. If additional changes are picked up during this second cycle,
   * bindings in the app have side-effects that cannot be resolved in a single change detection
   * pass.
   * In this case, Angular throws an error, since an Angular application can only have one change
   * detection pass during which all change detection must complete.
   */
  tick(): void {
    (typeof ngDevMode === 'undefined' || ngDevMode) && this.warnIfDestroyed();
    if (this._runningTick) {
      throw new RuntimeError(
          RuntimeErrorCode.RECURSIVE_APPLICATION_REF_TICK,
          ngDevMode && 'ApplicationRef.tick is called recursively');
    }

    try {
      this._runningTick = true;
      for (let view of this._views) {
        view.detectChanges();
      }
      if (typeof ngDevMode === 'undefined' || ngDevMode) {
        for (let view of this._views) {
          view.checkNoChanges();
        }
      }
    } catch (e) {
      // Attention: Don't rethrow as it could cancel subscriptions to Observables!
      this.internalErrorHandler(e);
    } finally {
      // Catch any `ExpressionChanged...` errors and report them to error handler like above
      try {
        const callbacksExecuted = this.afterRenderEffectManager.execute();
        if ((typeof ngDevMode === 'undefined' || ngDevMode) && callbacksExecuted) {
          for (let view of this._views) {
            view.checkNoChanges();
          }
        }
      } catch (e) {
        this.internalErrorHandler(e);
      }

      this._runningTick = false;
    }
  }

  /**
   * Attaches a view so that it will be dirty checked.
   * The view will be automatically detached when it is destroyed.
   * This will throw if the view is already attached to a ViewContainer.
   */
  attachView(viewRef: ViewRef): void {
    (typeof ngDevMode === 'undefined' || ngDevMode) && this.warnIfDestroyed();
    const view = (viewRef as InternalViewRef<unknown>);
    this._views.push(view);
    view.attachToAppRef(this);
  }

  /**
   * Detaches a view from dirty checking again.
   */
  detachView(viewRef: ViewRef): void {
    (typeof ngDevMode === 'undefined' || ngDevMode) && this.warnIfDestroyed();
    const view = (viewRef as InternalViewRef<unknown>);
    remove(this._views, view);
    view.detachFromAppRef();
  }

  private _loadComponent(componentRef: ComponentRef<any>): void {
    this.attachView(componentRef.hostView);
    this.tick();
    this.components.push(componentRef);
    // Get the listeners lazily to prevent DI cycles.
    const listeners = this._injector.get(APP_BOOTSTRAP_LISTENER, []);
    if (ngDevMode && !Array.isArray(listeners)) {
      throw new RuntimeError(
          RuntimeErrorCode.INVALID_MULTI_PROVIDER,
          'Unexpected type of the `APP_BOOTSTRAP_LISTENER` token value ' +
              `(expected an array, but got ${typeof listeners}). ` +
              'Please check that the `APP_BOOTSTRAP_LISTENER` token is configured as a ' +
              '`multi: true` provider.');
    }
    [...this._bootstrapListeners, ...listeners].forEach((listener) => listener(componentRef));
  }

  /** @internal */
  ngOnDestroy() {
    if (this._destroyed) return;

    try {
      // Call all the lifecycle hooks.
      this._destroyListeners.forEach(listener => listener());

      // Destroy all registered views.
      this._views.slice().forEach((view) => view.destroy());
    } finally {
      // Indicate that this instance is destroyed.
      this._destroyed = true;

      // Release all references.
      this._views = [];
      this._bootstrapListeners = [];
      this._destroyListeners = [];
    }
  }

  /**
   * Registers a listener to be called when an instance is destroyed.
   *
   * @param callback A callback function to add as a listener.
   * @returns A function which unregisters a listener.
   */
  onDestroy(callback: () => void): VoidFunction {
    (typeof ngDevMode === 'undefined' || ngDevMode) && this.warnIfDestroyed();
    this._destroyListeners.push(callback);
    return () => remove(this._destroyListeners, callback);
  }

  /**
   * Destroys an Angular application represented by this `ApplicationRef`. Calling this function
   * will destroy the associated environment injectors as well as all the bootstrapped components
   * with their views.
   */
  destroy(): void {
    if (this._destroyed) {
      throw new RuntimeError(
          RuntimeErrorCode.APPLICATION_REF_ALREADY_DESTROYED,
          ngDevMode && 'This instance of the `ApplicationRef` has already been destroyed.');
    }

    // This is a temporary type to represent an instance of an R3Injector, which can be destroyed.
    // The type will be replaced with a different one once destroyable injector type is available.
    type DestroyableInjector = Injector&{destroy?: Function, destroyed?: boolean};

    const injector = this._injector as DestroyableInjector;

    // Check that this injector instance supports destroy operation.
    if (injector.destroy && !injector.destroyed) {
      // Destroying an underlying injector will trigger the `ngOnDestroy` lifecycle
      // hook, which invokes the remaining cleanup actions.
      injector.destroy();
    }
  }

  /**
   * Returns the number of attached views.
   */
  get viewCount() {
    return this._views.length;
  }

  private warnIfDestroyed() {
    if ((typeof ngDevMode === 'undefined' || ngDevMode) && this._destroyed) {
      console.warn(formatRuntimeError(
          RuntimeErrorCode.APPLICATION_REF_ALREADY_DESTROYED,
          'This instance of the `ApplicationRef` has already been destroyed.'));
    }
  }
}

export function remove<T>(list: T[], el: T): void {
  const index = list.indexOf(el);
  if (index > -1) {
    list.splice(index, 1);
  }
}

function _lastDefined<T>(args: T[]): T|undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] !== undefined) {
      return args[i];
    }
  }
  return undefined;
}


let whenStableStore: WeakMap<ApplicationRef, Promise<void>>|undefined;
/**
 * Returns a Promise that resolves when the application becomes stable after this method is called
 * the first time.
 */
export function whenStable(applicationRef: ApplicationRef): Promise<void> {
  whenStableStore ??= new WeakMap();
  const cachedWhenStable = whenStableStore.get(applicationRef);
  if (cachedWhenStable) {
    return cachedWhenStable;
  }

  const whenStablePromise =
      applicationRef.isStable.pipe(first((isStable) => isStable)).toPromise().then(() => void 0);
  whenStableStore.set(applicationRef, whenStablePromise);

  // Be a good citizen and clean the store `onDestroy` even though we are using `WeakMap`.
  applicationRef.onDestroy(() => whenStableStore?.delete(applicationRef));

  return whenStablePromise;
}
