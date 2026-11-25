import type { AgentDefinition } from './definition.js';

export const EXAMPLES: Readonly<Record<string, AgentDefinition>> = {
  reviewer: {
    description: 'Reviews a change and reports findings without editing files',
    prompt:
      'Review the change the task names. Read the diff and the code around it, then report correctness problems, risks and missing tests. Do not edit files.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    allowedTools: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
  },
  researcher: {
    description: 'Answers a question from the code base and the web, read-only',
    prompt:
      'Answer the question the task asks. Search the code base and the web, cite what you found, and say what you could not confirm.',
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  },
};
