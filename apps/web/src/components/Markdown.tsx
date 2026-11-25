import { Anchor, Box } from '@mantine/core';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

export function Markdown(props: { readonly children: string }): ReactNode {
  return (
    <Box className="markdown" style={{ overflowWrap: 'anywhere' }}>
      <ReactMarkdown
        skipHtml
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
