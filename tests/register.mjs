import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Vite's import.meta.env does not exist under Node. Modules that read it (src/net/firebaseApp.ts,
// src/main.tsx) get a plain object instead: DEV false, VITE_* from the process environment.
globalThis.__viteEnv ??= {
  DEV: false,
  PROD: true,
  MODE: 'test',
  BASE_URL: '/',
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))),
};

// Run the application's TypeScript directly with Node's test runner; no browser or new dependencies.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL) {
      for (const suffix of ['.ts', '.tsx']) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') || url.endsWith('.tsx')) {
      // fileName matters: without it transpileModule treats every file as .tsx and reads generic
      // arrows such as `<T>(v: T)` in a .ts file as JSX.
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      }).outputText.replace(/import\.meta\.env/g, 'globalThis.__viteEnv');
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
