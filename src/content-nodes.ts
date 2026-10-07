import { z } from 'zod';
import type { NodeDefinition } from './runtime.js';
import { ContentStore, contentSchemas } from './content.js';

export function contentNodes(store: ContentStore): NodeDefinition[] {
  return [
    {
      name: 'lattis.content.get', packageName: '@lattis/content', kind: 'query', action: 'content.read', resourceType: 'content',
      resourceId: (input) => (input as { id: string }).id,
      input: z.object({ id: z.uuid() }).strict(), output: z.unknown(),
      handler: async (context,input) => store.get((input as { id: string }).id,context.db),
    },
    {
      name: 'lattis.content.create', packageName: '@lattis/content', kind: 'command', action: 'content.write', resourceType: 'content',
      resourceId: () => '*', input: contentSchemas.contentInput, output: z.unknown(),
      handler: async (context,input) => store.create(input,context.db),
    },
    {
      name: 'lattis.content.update', packageName: '@lattis/content', kind: 'command', action: 'content.write', resourceType: 'content',
      resourceId: (input) => (input as { id: string }).id,
      input: z.object({ id: z.uuid(), expectedRevision: z.number().int().positive(), content: contentSchemas.contentInput }).strict(), output: z.unknown(),
      handler: async (context,input) => {
        const value = input as { id: string; expectedRevision: number; content: unknown };
        return store.update(value.id,value.content,value.expectedRevision,context.db);
      },
    },
    {
      name: 'lattis.content.links.replace', packageName: '@lattis/content', kind: 'command', action: 'content.write', resourceType: 'content',
      resourceId: (input) => (input as { id: string }).id,
      input: z.object({ id: z.uuid(), links: z.array(contentSchemas.link).max(500) }).strict(), output: z.unknown(),
      handler: async (context,input) => {
        const value = input as { id: string; links: unknown };
        return store.setLinks(value.id,value.links,context.db);
      },
    },
  ];
}
