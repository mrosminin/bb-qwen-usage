import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const account = { accountEmail: z.string().nullable(), planLabel: z.string().nullable(), plan: z.null() };
const resource = z.object({
  id: z.string().min(1), accountKey: z.null(), providerId: z.string(), label: z.string(),
  scope: z.object({ kind: z.literal('host'), hostId: z.string(), hostName: z.string() }),
});
const usage = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), ...account, windows: z.array(z.object({
    id: z.string(), label: z.string(), kind: z.literal('weekly'), usedPercent: z.number().min(0).max(100),
    resetsAt: z.null(), model: z.null(), cost: z.null(),
  })) }),
  z.object({ status: z.literal('error'), ...account, message: z.string() }),
]);

export const contract = defineRpcContract({
  'provider-usage.v1.listResources': {
    input: z.object({}).strict(), output: z.object({ resources: z.array(resource) }),
    experimental_description: 'Qwen Code usage resources. Metadata only; never contacts the quota website.',
  },
  'provider-usage.v1.getResource': {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }).strict(),
    output: z.object({ accountKey: z.null(), observedAt: z.number().int().nonnegative().nullable(), usage }),
    experimental_description: 'Read one Qwen quota tab. Cache 60 seconds; refresh forces a fresh attempt.',
  },
});
