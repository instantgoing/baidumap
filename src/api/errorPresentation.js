const PRESENTATIONS = Object.freeze({
  configuration_error: { title: '未配置服务端 AK', action: '在 FastAPI 运行环境配置 BAIDU_SERVICE_AK 后重试；页面不会自动切换成样例。' },
  upstream_auth_error: { title: '百度服务鉴权失败', action: '检查服务端 AK 类型、IP 白名单和服务权限。' },
  rate_limit: { title: '上游配额或 QPS 受限', action: '等待限流窗口后安全重试，不要提高并发绕过配额。' },
  timeout: { title: '在线请求超时', action: '检查网络与上游状态后重试；已完成的失败不会标记为成功。' },
  upstream_error: { title: '百度上游服务暂不可用', action: '有限重试已结束，请稍后重试或使用明确标注的固定演示模式。' },
  service_error: { title: '后端服务暂不可用', action: '检查 FastAPI 和上游状态，保留请求 ID 用于诊断。' },
  circuit_open: { title: '服务保护已启动', action: '连续失败已触发熔断，请等待冷却窗口后重试。' },
  empty_result: { title: '没有可用结果', action: '调整位置或检索范围后重试；空结果不会生成伪造数据。' },
  network: { title: '无法连接在线服务', action: '检查现场网络和 API 地址；需要演示时请显式启动 sample-snapshot。' },
  network_error: { title: '无法连接百度服务', action: '检查 FastAPI 出口网络，恢复后再重试。' },
  malformed_response: { title: '服务响应格式异常', action: '响应已被拒绝，不会继续生成报告。' },
})

export function presentApiError(error) {
  const kind = String(error?.kind || 'unknown')
  const fallback = { title: '分析失败', action: '检查错误详情后安全重试。' }
  const presentation = PRESENTATIONS[kind] || fallback
  const detail = String(error?.message || '未知错误')
  return {
    kind,
    title: presentation.title,
    detail,
    action: presentation.action,
    requestId: String(error?.requestId || ''),
    summary: `${presentation.title}：${detail}`,
  }
}
