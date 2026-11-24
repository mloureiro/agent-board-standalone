import path from 'node:path';

const SHARED = ['contract', 'sealing'];

export const PARTS = [
  { name: 'contract', directory: 'packages/contract', allowed: [] },
  { name: 'sealing', directory: 'packages/sealing', allowed: [] },
  { name: 'api', directory: 'apps/api', allowed: SHARED },
  { name: 'cli', directory: 'apps/cli', allowed: SHARED },
  { name: 'web', directory: 'apps/web', allowed: SHARED },
  { name: 'migrate', directory: 'apps/migrate', allowed: SHARED },
  { name: 'e2e', directory: 'e2e', allowed: SHARED },
  { name: 'server-app', directory: 'apps/server-app', allowed: ['api'] },
  { name: 'client-app', directory: 'apps/client-app', allowed: ['web'] },
  { name: 'mobile', directory: 'apps/mobile', allowed: ['web'] },
  { name: 'tools', directory: 'tools/repo', allowed: [] },
];

const PACKAGE_SCOPE = '@agent-board/';
const PACKAGE_ALIASES = { 'repo-tools': 'tools' };

function partOfPath(root, absolutePath) {
  const relative = path.relative(root, absolutePath).split(path.sep).join('/');
  const found = PARTS.find(
    (part) => relative === part.directory || relative.startsWith(`${part.directory}/`),
  );
  return found?.name ?? null;
}

function partOfSpecifier(root, file, specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return partOfPath(root, path.resolve(path.dirname(file), specifier));
  }
  if (specifier.startsWith(PACKAGE_SCOPE)) {
    const name = specifier.slice(PACKAGE_SCOPE.length).split('/')[0];
    const part = PACKAGE_ALIASES[name] ?? name;
    return PARTS.some((candidate) => candidate.name === part) ? part : null;
  }
  return null;
}

export const parts = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden: '{{from}} may not import {{to}}; allowed: {{allowed}}',
    },
  },
  create(context) {
    const root = context.cwd;
    const file = context.filename;
    const from = partOfPath(root, file);
    if (from === null) return {};
    const allowed = PARTS.find((part) => part.name === from).allowed;

    function check(node, source) {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const to = partOfSpecifier(root, file, source.value);
      if (to === null || to === from || allowed.includes(to)) return;
      context.report({
        node,
        messageId: 'forbidden',
        data: { from, to, allowed: allowed.length > 0 ? allowed.join(', ') : 'nothing' },
      });
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, node.arguments[0]);
        }
      },
    };
  },
};
