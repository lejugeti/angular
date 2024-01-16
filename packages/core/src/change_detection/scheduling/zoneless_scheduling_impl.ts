/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef} from '../../application/application_ref';
import {EnvironmentProviders, inject, Injectable, makeEnvironmentProviders} from '../../di';
import {PendingTasks} from '../../pending_tasks';
import {NgZone, NoopNgZone} from '../../zone/ng_zone';

import {ChangeDetectionScheduler} from './zoneless_scheduling';

@Injectable({providedIn: 'root'})
class ChangeDetectionSchedulerImpl implements ChangeDetectionScheduler {
  private appRef = inject(ApplicationRef);
  private taskService = inject(PendingTasks);
  private pendingRenderTaskId: number|null = null;

  notify(): void {
    if (this.pendingRenderTaskId !== null) return;

    this.pendingRenderTaskId = this.taskService.add();
    setTimeout(() => {
      try {
        if (!this.appRef.destroyed) {
          this.appRef.tick();
        }
      } finally {
        // If this is the last task, the service will synchronously emit a stable notification. If
        // there is a subscriber that then acts in a way that tries to notify the scheduler again,
        // we need to be able to respond to schedule a new change detection. Therefore, we should
        // clear the task ID before removing it from the pending tasks (or the tasks service should
        // not synchronously emit stable, similar to how Zone stableness only happens if it's still
        // stable after a microtask).
        const taskId = this.pendingRenderTaskId!;
        this.pendingRenderTaskId = null;
        this.taskService.remove(taskId);
      }
    });
  }
}

export function provideZonelessChangeDetection(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {provide: ChangeDetectionScheduler, useExisting: ChangeDetectionSchedulerImpl},
    {provide: NgZone, useClass: NoopNgZone},
  ]);
}
