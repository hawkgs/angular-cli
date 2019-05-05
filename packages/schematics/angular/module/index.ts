/**
* @license
* Copyright Google Inc. All Rights Reserved.
*
* Use of this source code is governed by an MIT-style license that can be
* found in the LICENSE file at https://angular.io/license
*/
import { Path, normalize, strings } from '@angular-devkit/core';
import {
  Rule,
  SchematicsException,
  Tree,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  noop,
  schematic,
  url,
} from '@angular-devkit/schematics';
import * as ts from '../third_party/github.com/Microsoft/TypeScript/lib/typescript';
import { addImportToModule, addRouteDeclarationToModule } from '../utility/ast-utils';
import { InsertChange } from '../utility/change';
import { buildRelativePath, findModuleFromOptions } from '../utility/find-module';
import { applyLintFix } from '../utility/lint-fix';
import { parseName } from '../utility/parse-name';
import { getProject, isProjectUsingIvy } from '../utility/project';
import { createDefaultPath } from '../utility/workspace';
import { WorkspaceProject } from '../utility/workspace-models';
import { RoutingScope, Schema as ModuleOptions } from './schema';

function addDeclarationToNgModule(options: ModuleOptions): Rule {
  return (host: Tree) => {
    if (!options.module) {
      return host;
    }

    const modulePath = options.module;

    const text = host.read(modulePath);
    if (text === null) {
      throw new SchematicsException(`File ${modulePath} does not exist.`);
    }
    const sourceText = text.toString('utf-8');
    const source = ts.createSourceFile(modulePath, sourceText, ts.ScriptTarget.Latest, true);

    const importModulePath = normalize(
      `/${options.path}/`
      + (options.flat ? '' : strings.dasherize(options.name) + '/')
      + strings.dasherize(options.name)
      + '.module',
    );
    const relativePath = buildRelativePath(modulePath, importModulePath);
    const changes = addImportToModule(source,
                                      modulePath,
                                      strings.classify(`${options.name}Module`),
                                      relativePath);

    const recorder = host.beginUpdate(modulePath);
    for (const change of changes) {
      if (change instanceof InsertChange) {
        recorder.insertLeft(change.pos, change.toAdd);
      }
    }
    host.commitUpdate(recorder);

    return host;
  };
}

function addRouteDeclarationToNgModule(
  options: ModuleOptions,
  project: WorkspaceProject,
  routingModulePath: Path | undefined,
): Rule {
  return (host: Tree) => {
    if (!options.route) {
      return host;
    }
    if (options.route && !options.module) {
      throw new Error('Module option required when creating a lazy loaded routing module.');
    }

    let path: string;
    if (routingModulePath) {
      path = routingModulePath as string;
    } else {
      path = options.module as string;
    }

    const text = host.read(path);
    if (!text) {
      throw new Error(`Couldn't find the module nor its routing module.`);
    }

    const ivyEnabled = isProjectUsingIvy(host, project);
    const sourceText = text.toString('utf-8');
    const addDeclaration = addRouteDeclarationToModule(
      ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true),
      path,
      buildRoute(options, ivyEnabled),
    ) as InsertChange;

    const recorder = host.beginUpdate(path);
    recorder.insertLeft(addDeclaration.pos, addDeclaration.toAdd);
    host.commitUpdate(recorder);

    return host;
  };
}

function getRoutingModulePath(host: Tree, options: ModuleOptions): Path | undefined {
  let path: Path | undefined;
  const modulePath = options.module as string;
  const routingModuleName = modulePath.split('.')[0] + '-routing';
  const { module, ...rest } = options;

  try {
    path = findModuleFromOptions(host, { module: routingModuleName, ...rest });
  } catch {}

  return path;
}

function buildRoute(options: ModuleOptions, ivyEnabled: boolean) {
  let loadChildren: string;
  const modulePath = `./${options.name}/${options.name}.module`;
  const moduleName = `${strings.classify(options.name)}Module`;

  if (ivyEnabled) {
    loadChildren = `() => import('${modulePath}').then(m => m.${moduleName})`;
  } else {
    loadChildren = `'${modulePath}#${moduleName}'`;
  }

  return `{ path: '${options.route}', loadChildren: ${loadChildren} }`;
}

export default function (options: ModuleOptions): Rule {
  return async (host: Tree) => {
    if (options.path === undefined) {
      options.path = await createDefaultPath(host, options.project as string);
    }

    if (options.module) {
      options.module = findModuleFromOptions(host, options);
    }

    const parsedPath = parseName(options.path, options.name);
    options.name = parsedPath.name;
    options.path = parsedPath.path;

    let routingModulePath: Path | undefined;
    const isLazyLoadedModuleGen = options.route && options.module;
    if (isLazyLoadedModuleGen) {
      options.routingScope = RoutingScope.Child;
      routingModulePath = getRoutingModulePath(host, options);
    }

    const project = getProject(host, options.project as string);
    const templateSource = apply(url('./files'), [
      options.routing || isLazyLoadedModuleGen && !!routingModulePath
        ? noop()
        : filter(path => !path.endsWith('-routing.module.ts.template')),
      applyTemplates({
        ...strings,
        'if-flat': (s: string) => options.flat ? '' : s,
        lazyRoute: isLazyLoadedModuleGen,
        routeDeclarationInlined: !routingModulePath,
        ...options,
      }),
      move(parsedPath.path),
    ]);

    return chain([
      !isLazyLoadedModuleGen ? addDeclarationToNgModule(options) : noop(),
      addRouteDeclarationToNgModule(options, project, routingModulePath),
      isLazyLoadedModuleGen
        ? schematic('component', {
            ...options,
            skipImport: true,
          })
        : noop(),
      mergeWith(templateSource),
      options.lintFix ? applyLintFix(options.path) : noop(),
    ]);
  };
}
