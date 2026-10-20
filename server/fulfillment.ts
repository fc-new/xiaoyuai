export const redemptionLabels = { pending: '待处理', processing: '处理中', completed: '已完成', failed: '处理失败', review: '待核查', cancelled: '已取消' };
export type RedemptionStatus = keyof typeof redemptionLabels;
export const fulfillmentTransitions: Record<RedemptionStatus, RedemptionStatus[]> = {
  pending: ['processing', 'cancelled'], processing: ['processing', 'completed', 'failed', 'review'],
  failed: ['pending', 'cancelled'], review: ['review', 'completed', 'failed'], completed: [], cancelled: [],
};
// A future authorized provider must implement submission with an idempotency key,
// read-only reconciliation, and verified delivery evidence before enabling dispatch.
export interface FulfillmentProvider {
  submit(input: { redemptionId: string; idempotencyKey: string; targetEmail: string; planId: string }): Promise<{ reference: string; status: 'processing' | 'review' }>;
  reconcile(reference: string): Promise<{ status: 'processing' | 'review' | 'completed' | 'failed'; evidence?: string }>;
}
export const fulfillmentInfo = {
  mode: 'manual', automaticRecharge: false, queue: 'manual-default',
  note: '兑换自动进入人工履约队列；完成需由处理人员核实交付凭据。尚未配置获得授权且可验证结果的自动开通接口。',
};
