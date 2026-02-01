import { UsageConfig, UsageData } from "../config/types";
import { recordUsage, getTodayUsage } from "./usage-log";

/**
 * NewAPI 用量查询
 * 参考: https://github.com/Calcium-Ion/new-api
 */
export async function queryNewAPIUsage(
  baseUrl: string,
  accessToken: string,
  userId?: string,
  providerId?: string
): Promise<UsageData> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  };

  if (userId) {
    headers['New-Api-User'] = userId;
  }

  const response = await fetch(`${baseUrl}/api/user/self`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.message || '查询失败');
  }

  // quota 单位是 500000 = 1 USD
  const quotaToUSD = (quota: number) => quota / 500000;
  const remainingUSD = quotaToUSD(data.data.quota || 0);
  const usedUSD = quotaToUSD(data.data.used_quota || 0);
  const totalUSD = remainingUSD + usedUSD;

  // Record usage for today calculation
  if (providerId) {
    recordUsage(providerId, remainingUSD, usedUSD, 'USD');
  }

  // Get today's usage from local log
  const todayUsed = providerId ? getTodayUsage(providerId) : undefined;

  return {
    planName: data.data.group || '默认套餐',
    total: totalUSD,
    used: usedUSD,
    remaining: remainingUSD,
    todayUsed,
    requestCount: data.data.request_count,
    unit: 'USD',
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 自定义脚本用量查询
 */
export async function queryCustomUsage(customScript: string): Promise<UsageData> {
  // 解析脚本
  // eslint-disable-next-line no-new-func
  const scriptFn = new Function(`return ${customScript}`)();

  if (!scriptFn || !scriptFn.request) {
    throw new Error('Invalid script: missing request configuration');
  }

  const { request, extractor } = scriptFn;

  // 发送请求
  const fetchOptions: RequestInit = {
    method: request.method || 'GET',
    headers: request.headers || {},
  };

  if (request.body) {
    fetchOptions.body = typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);
  }

  const response = await fetch(request.url, fetchOptions);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const responseData = await response.json();

  // 使用 extractor 提取数据
  if (typeof extractor === 'function') {
    const result = extractor(responseData);
    if (result.error) {
      throw new Error(result.error);
    }
    return {
      planName: result.planName,
      total: result.total,
      used: result.used,
      remaining: result.remaining,
      unit: result.unit,
      lastUpdated: new Date().toISOString(),
    };
  }

  throw new Error('Invalid script: missing extractor function');
}

/**
 * 根据配置查询用量
 */
export async function queryUsage(config: UsageConfig, providerId?: string): Promise<UsageData> {
  if (!config.enabled) {
    throw new Error('Usage query not enabled');
  }

  if (config.templateType === 'newapi') {
    if (!config.baseUrl || !config.accessToken) {
      throw new Error('NewAPI requires baseUrl and accessToken');
    }
    return queryNewAPIUsage(config.baseUrl, config.accessToken, config.userId, providerId);
  }

  if (config.templateType === 'custom') {
    if (!config.customScript) {
      throw new Error('Custom template requires customScript');
    }
    return queryCustomUsage(config.customScript);
  }

  throw new Error(`Unknown template type: ${config.templateType}`);
}
