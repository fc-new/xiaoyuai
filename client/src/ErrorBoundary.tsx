import { Component, type ReactNode } from 'react';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="startup-shell" role="alert"><img src="/favicon.svg" alt="小鱼 AI"/><h1>页面暂时没有加载完成</h1><p>请重新加载后重试，已保存的订单查询信息会保留。</p><button onClick={() => window.location.reload()}>重新加载页面</button></main>;
    return this.props.children;
  }
}
