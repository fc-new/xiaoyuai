export const plans = [
  {
    id: 'plus-month', name: 'Plus 月度', subtitle: '让每一天，多一点可能', price: 16800,
    period: '月', tag: '轻松开始', featured: false, tier: 'PLUS',
    features: ['ChatGPT Plus 月度开通协助', '使用你自己的独立账号', '人工一对一处理', '全程订单进度可查询'],
  },
  {
    id: 'plus-quarter', name: 'Plus 季度', subtitle: '为持续创造，留足空间', price: 48800,
    period: '3 个月', tag: '推荐选择', featured: true, tier: 'PLUS',
    features: ['连续 3 个月的开通协助', '使用你自己的独立账号', '专人跟进每次开通', '每次交付说明留档'],
  },
  {
    id: 'pro-month', name: 'Pro 月度', subtitle: '给高频创作者，更大天地', price: 169800,
    period: '月', tag: '进阶之选', featured: false, tier: 'PRO',
    features: ['ChatGPT Pro 月度开通协助', '开通前人工确认适用条件', '专人跟进处理进度', '独立账号与交付记录'],
  },
] as const;

export type OrderStatus = 'pending_payment' | 'paid' | 'processing' | 'completed' | 'cancelled' | 'expired' | 'refund_pending' | 'refunded';
export const statusLabels: Record<OrderStatus, string> = {
  expired: '已过期', refund_pending: '退款处理中', refunded: '已退款', pending_payment: '待付款', paid: '已付款', processing: '协助开通中', completed: '已完成', cancelled: '已取消',
};
