import { Anchor, Box } from '@mantine/core';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

import { linkRulesPlugin, type LinkRule } from './link-rules.js';

const LinkRulesContext = createContext<readonly LinkRule[]>([]);

export function LinkRulesProvider(props: {
  readonly rules: readonly LinkRule[];
  readonly children: ReactNode;
}): ReactNode {
  return (
    <LinkRulesContext.Provider value={props.rules}>{props.children}</LinkRulesContext.Provider>
  );
}

export function Markdown(props: { readonly children: string }): ReactNode {
  const rules = useContext(LinkRulesContext);
  const remarkPlugins = useMemo(() => [linkRulesPlugin(rules)], [rules]);
  return (
    <Box className="markdown" style={{ overflowWrap: 'anywhere' }}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <Anchor href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </Anchor>
          ),
          img: ({ alt }) => <span>{alt ?? ''}</span>,
        }}
      >
        {props.children}
      </ReactMarkdown>
    </Box>
  );
}
